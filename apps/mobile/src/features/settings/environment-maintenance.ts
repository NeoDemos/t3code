import {
  AuthEnvironmentMaintainScope,
  sessionGrantsScope,
  type AuthSessionState,
  type ExecutionEnvironmentCapabilities,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  CLI_RELEASE_DIST_TAGS_URL,
  cliReleaseChannelOf,
  cliReleaseVersionFromDistTags,
} from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Schema from "effect/Schema";

export function canMaintainEnvironment(session: AuthSessionState | null, connected: boolean) {
  return (
    connected &&
    session?.authenticated === true &&
    sessionGrantsScope(session, AuthEnvironmentMaintainScope)
  );
}

export function supportsEnvironmentUpdate(
  capabilities: Pick<ExecutionEnvironmentCapabilities, "serverSelfUpdate" | "desktopAppUpdate">,
) {
  return (
    capabilities.serverSelfUpdate !== undefined &&
    (capabilities.serverSelfUpdate !== "desktop-managed" || capabilities.desktopAppUpdate === true)
  );
}

export function canUpdateEnvironmentProvider(provider: ServerProvider) {
  const compatibility = provider.compatibilityAdvisory?.latestVersionStatus;
  return (
    provider.installed &&
    provider.availability !== "unavailable" &&
    provider.versionAdvisory?.status === "behind_latest" &&
    provider.versionAdvisory.canUpdate &&
    provider.versionAdvisory.latestVersion !== null &&
    compatibility !== "broken" &&
    compatibility !== "unsupported" &&
    provider.updateState?.status !== "running" &&
    provider.updateState?.status !== "queued"
  );
}

const decodeDistTags = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String));

export async function findEnvironmentUpdate(currentVersion: string, signal: AbortSignal) {
  const channel = cliReleaseChannelOf(currentVersion);
  const response = await fetch(CLI_RELEASE_DIST_TAGS_URL, { signal });
  if (!response.ok) throw new Error(`Could not check releases (${response.status}). Try again.`);
  const version = cliReleaseVersionFromDistTags(decodeDistTags(await response.json()), channel);
  if (version === undefined) throw new Error(`No ${channel} release was found.`);
  return compareSemverVersions(version, currentVersion) > 0 ? version : null;
}
