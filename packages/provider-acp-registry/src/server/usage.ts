import { type UsageTokenTotals } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  tokenCount,
  type ProviderUsageReader,
  type ProviderUsageScan,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { AcpRegistrySettings } from "../settings.ts";

const MISTRAL_VIBE_AGENT_ID = "mistral-vibe";
const UNKNOWN_MODEL = "unknown";

/**
 * Vibe writes cumulative per-session token counts under
 * `<vibe home>/logs/session/unified/<session id>/`. Each session directory
 * holds a `CURRENT` pointer to the latest published generation, whose
 * `projection-state.json` carries the session's cumulative `tokenUsage`, and
 * whose `runtime-state.json` records the active model. A `.session-index.json`
 * catalog in the same directory caches the same reading with the recovery
 * journal applied, so it can be fresher than the published generation; it is
 * only rewritten when Vibe itself lists sessions, so it can also lag. The
 * reader merges both and keeps whichever reading is newer.
 */

function isMistralVibeInstance(config: AcpRegistrySettings | undefined): boolean {
  if (config === undefined) return false;
  if (config.source === "registry") return config.agentId === MISTRAL_VIBE_AGENT_ID;
  // Local commands run the vibe ACP binary (`vibe-acp`) or a `mistral-vibe` build.
  return config.commandPath.split(/[\\/]/).pop()!.toLowerCase().includes("vibe");
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

interface SessionUsageReading {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly updatedAt: number;
  readonly model: string | null;
}

/**
 * Vibe's `inputTokens` includes the cached portion, so the uncached share is
 * the difference. Returns null when the reading carries no usage or no
 * timestamp to bucket it by.
 */
function readingFromTokenUsage(
  tokenUsage: unknown,
  updatedAt: unknown,
  model: unknown,
): SessionUsageReading | null {
  const usage = object(tokenUsage);
  const inputTokens = tokenCount(usage.inputTokens);
  const cachedInputTokens = Math.min(tokenCount(usage.cachedInputTokens), inputTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  if (inputTokens + outputTokens === 0) return null;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return null;
  return { inputTokens, cachedInputTokens, outputTokens, updatedAt, model: text(model) };
}

const decodeUnknownJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const readJsonFile = Effect.fnUntraced(function* (
  filePath: string,
): Effect.fn.Return<unknown, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(filePath).pipe(
    Effect.map((source) => Option.getOrNull(decodeUnknownJson(source))),
    Effect.orElseSucceed(() => null),
  );
});

function parseSessionCatalog(parsed: unknown): ReadonlyMap<string, SessionUsageReading> {
  const entries = new Map<string, SessionUsageReading>();
  const document = object(parsed);
  const list = Array.isArray(document.entries) ? document.entries : [];
  for (const entry of list) {
    const record = object(entry);
    const sessionId = text(record.session_id) ?? text(object(record.identity).session_id);
    if (sessionId === null) continue;
    const session = object(record.session);
    const reading = readingFromTokenUsage(
      session.tokenUsage,
      session.updatedAt,
      object(record.metadata).active_model,
    );
    if (reading === null) continue;
    entries.set(sessionId, reading);
  }
  return entries;
}

const readRuntimeStateModel = Effect.fn("mistralVibeUsage.readRuntimeStateModel")(function* (
  generationDir: string,
): Effect.fn.Return<string | null, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const runtimeState = yield* readJsonFile(path.join(generationDir, "runtime-state.json"));
  return text(object(object(runtimeState).session_metadata).active_model);
});

const readSessionDirectory = Effect.fn("mistralVibeUsage.readSessionDirectory")(function* (
  sessionDir: string,
  catalogEntry: SessionUsageReading | undefined,
): Effect.fn.Return<
  {
    readonly projectionPath: string;
    readonly reading: SessionUsageReading;
    readonly model: string;
  } | null,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const info = yield* fileSystem.stat(sessionDir).pipe(Effect.orElseSucceed(() => null));
  if (info?.type !== "Directory") return null;
  const generationsDir = path.join(sessionDir, "generations");
  const generationNames = yield* fileSystem.readDirectory(generationsDir).pipe(
    Effect.map((names) => names.filter((name) => /^\d{16}$/.test(name)).sort()),
    Effect.orElseSucceed(() => [] as string[]),
  );
  // `CURRENT` names the published generation; a missing or stale pointer falls
  // back to the last generation on disk.
  const current = yield* readJsonFile(path.join(sessionDir, "CURRENT"));
  const currentGeneration = text(object(current).generation);
  const generation =
    currentGeneration !== null && generationNames.includes(currentGeneration)
      ? currentGeneration
      : (generationNames.at(-1) ?? null);
  if (generation === null) return null;
  const generationDir = path.join(generationsDir, generation);
  const projection = yield* readJsonFile(path.join(generationDir, "projection-state.json"));
  const session = object(object(object(projection).snapshot).session);
  const published = readingFromTokenUsage(session.tokenUsage, session.updatedAt, null);
  if (published === null) return null;
  const reading =
    catalogEntry !== undefined && catalogEntry.updatedAt > published.updatedAt
      ? catalogEntry
      : published;
  // The active model is fixed for a session's lifetime, so the catalog's copy
  // is authoritative even when its usage reading lost the freshness race.
  const model =
    catalogEntry?.model ?? (yield* readRuntimeStateModel(generationDir)) ?? UNKNOWN_MODEL;
  return { projectionPath: path.join(generationDir, "projection-state.json"), reading, model };
});

function toUsageRecord(
  sessionId: string,
  root: string,
  reading: SessionUsageReading,
  model: string,
): UsageRecord {
  const totals: UsageTokenTotals = {
    uncachedInputTokens: Math.max(0, reading.inputTokens - reading.cachedInputTokens),
    cachedInputTokens: reading.cachedInputTokens,
    cacheCreationTokens: 0,
    outputTokens: reading.outputTokens,
    // Vibe folds reasoning into outputTokens and does not break it out.
    reasoningTokens: 0,
  };
  return {
    provider: "mistral",
    timestampMs: reading.updatedAt,
    model,
    sessionId,
    totals,
    // Vibe persists token counts but no dollar cost; the shared price table
    // estimates cost for models it knows.
    reportedCostUsd: null,
    speed: "standard",
    dedupeKey: `mistral:${root}:session:${sessionId}`,
  };
}

const resolveVibeSessionRoot = Effect.fn("mistralVibeUsage.resolveVibeSessionRoot")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const configured = environment["VIBE_HOME"]?.trim();
  const vibeHome = configured ? expandHomePath(configured, home) : path.join(home, ".vibe");
  const resolved = path.resolve(vibeHome);
  const canonical = yield* fileSystem.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
  return path.join(canonical, "logs", "session", "unified");
});

/** Session reads are small JSON documents; a few at a time keep a large history off the event loop's critical path. */
const SESSION_READ_CONCURRENCY = 8;

const scanSessionRoot = Effect.fn("mistralVibeUsage.scanSessionRoot")(function* (
  root: string,
  windowStartMs: number,
): Effect.fn.Return<ProviderUsageScan, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = yield* fileSystem
    .exists(root)
    .pipe(Effect.catchCause(() => Effect.succeed(false)));
  if (!exists) return { dir: root, files: null };
  const catalog = parseSessionCatalog(yield* readJsonFile(path.join(root, ".session-index.json")));
  const names = yield* fileSystem
    .readDirectory(root)
    .pipe(Effect.orElseSucceed(() => [] as string[]));
  const sessionNames = names.filter((name) => !name.startsWith(".")).sort();
  const results = yield* Effect.forEach(
    sessionNames,
    (name) =>
      Effect.map(
        readSessionDirectory(path.join(root, name), catalog.get(name)),
        (result) => ({ name, result }) as const,
      ),
    { concurrency: SESSION_READ_CONCURRENCY },
  );
  const files: { path: string; records: UsageRecord[] }[] = [];
  for (const { name, result } of results) {
    if (result === null || result.reading.updatedAt < windowStartMs) continue;
    files.push({
      path: result.projectionPath,
      records: [toUsageRecord(name, root, result.reading, result.model)],
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { dir: root, files, status: "ok" };
});

export type MistralVibeUsageReaderEnv = FileSystem.FileSystem | Path.Path;

export const mistralVibeUsageReader: ProviderUsageReader<
  AcpRegistrySettings,
  MistralVibeUsageReaderEnv
> = {
  kind: "scan",
  provider: "mistral",
  scan: Effect.fn("mistralVibeUsageReader.scan")(function* ({ instances, windowStartMs }) {
    const roots = new Set<string>();
    for (const instance of instances) {
      if (!isMistralVibeInstance(instance.config)) continue;
      roots.add(yield* resolveVibeSessionRoot(instance.environment));
    }
    return yield* Effect.forEach([...roots], (root) => scanSessionRoot(root, windowStartMs), {
      concurrency: "unbounded",
    });
  }),
};
