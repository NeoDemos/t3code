import {
  OrchestrationV2TurnItem,
  type OrchestrationV2ThreadProjection,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  deriveThreadQueueWorkflowState,
  getUserQueuedThreadRuns,
  type ThreadQueueWorkflowState,
} from "./threadWorkflows.ts";
import { deriveThreadTurnSubagents, type ThreadTurnSubagents } from "./threadSubagents.ts";
import {
  deriveThreadCheckpointSummaries,
  type ThreadCheckpointSummary,
} from "./threadCheckpoints.ts";
import type { EnvironmentThread } from "./models.ts";
import { EMPTY_ENVIRONMENT_THREAD_STATE, type EnvironmentThreadState } from "./threadState.ts";
import {
  createQuestionHistoryProjector,
  derivePendingThreadRequests,
  type PendingThreadRequests,
} from "./threadRequests.ts";
import { arrayElementsEqual, parseThreadKey, threadKey } from "./entities.ts";

const EMPTY_VISIBLE_TURN_ITEMS: OrchestrationV2ThreadProjection["visibleTurnItems"] = Object.freeze(
  [],
);
const EMPTY_CHECKPOINT_SUMMARIES: ReadonlyArray<ThreadCheckpointSummary> = Object.freeze([]);

const sameTurnItem = Schema.toEquivalence(OrchestrationV2TurnItem);

function sameApartFromStreamedText(
  previous: OrchestrationV2TurnItem,
  next: OrchestrationV2TurnItem,
): boolean {
  if (previous === next) return true;
  if (
    previous.id !== next.id ||
    (previous.type !== "assistant_message" && previous.type !== "reasoning") ||
    previous.type !== next.type
  ) {
    return false;
  }
  return sameTurnItem({ ...previous, text: next.text, updatedAt: next.updatedAt }, next);
}

/**
 * Whether `next` differs from `previous` only by text streamed into existing
 * assistant and reasoning items: the same items exist, with the same status,
 * and every other projection field is unchanged.
 */
export function onlyStreamedTextChanged(
  previous: OrchestrationV2ThreadProjection,
  next: OrchestrationV2ThreadProjection,
): boolean {
  if (previous === next) return true;
  for (const key of Object.keys(next) as Array<keyof OrchestrationV2ThreadProjection>) {
    if (key === "turnItems" || key === "visibleTurnItems" || key === "updatedAt") continue;
    if (previous[key] !== next[key]) return false;
  }
  if (
    previous.turnItems.length !== next.turnItems.length ||
    previous.visibleTurnItems.length !== next.visibleTurnItems.length
  ) {
    return false;
  }
  for (let index = 0; index < next.turnItems.length; index += 1) {
    if (!sameApartFromStreamedText(previous.turnItems[index]!, next.turnItems[index]!)) {
      return false;
    }
  }
  for (let index = 0; index < next.visibleTurnItems.length; index += 1) {
    const before = previous.visibleTurnItems[index]!;
    const after = next.visibleTurnItems[index]!;
    if (before === after) continue;
    if (
      before.position !== after.position ||
      before.visibility !== after.visibility ||
      before.sourceThreadId !== after.sourceThreadId ||
      before.sourceItemId !== after.sourceItemId ||
      !sameApartFromStreamedText(before.item, after.item)
    ) {
      return false;
    }
  }
  return true;
}

export function createEnvironmentThreadDetailAtoms<E>(
  threadStateAtom: (
    environmentId: ScopedThreadRef["environmentId"],
    threadId: ScopedThreadRef["threadId"],
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentThreadState, E>>,
) {
  const threadStateValueAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    return Atom.make((get) =>
      Option.getOrElse(
        AsyncResult.value(get(threadStateAtom(ref.environmentId, ref.threadId))),
        () => EMPTY_ENVIRONMENT_THREAD_STATE,
      ),
    ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-state-value:${key}`));
  });

  const threadAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    let previousProjection: OrchestrationV2ThreadProjection | null = null;
    let previousValue: EnvironmentThread | null = null;
    return Atom.make((get) => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (projection === previousProjection) return previousValue;
      previousProjection = projection;
      previousValue = projection === null ? null : { environmentId: ref.environmentId, projection };
      return previousValue;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread:${key}`));
  });

  // Streamed assistant and reasoning text replaces an item several times a
  // second. Readers of the thread's structure (runs, requests, which items
  // exist and their status) keep the previous value through those updates;
  // whatever shows the text reads threadAtom or visibleTurnItemsAtom.
  const quietThreadAtomFamily = Atom.family((key: string) => {
    let previous: EnvironmentThread | null = null;
    return Atom.make((get) => {
      const next = get(threadAtomFamily(key));
      if (
        previous !== null &&
        next !== null &&
        onlyStreamedTextChanged(previous.projection, next.projection)
      ) {
        return previous;
      }
      previous = next;
      return next;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-quiet-thread:${key}`));
  });

  const visibleTurnItemsAtomFamily = Atom.family((key: string) => {
    const projectQuestionHistory = createQuestionHistoryProjector();
    return Atom.make((get): OrchestrationV2ThreadProjection["visibleTurnItems"] => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      return projection === null ? EMPTY_VISIBLE_TURN_ITEMS : projectQuestionHistory(projection);
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-visible-turn-items:${key}`));
  });

  const quietVisibleTurnItemsAtomFamily = Atom.family((key: string) => {
    const projectQuestionHistory = createQuestionHistoryProjector();
    return Atom.make((get): OrchestrationV2ThreadProjection["visibleTurnItems"] => {
      const thread = get(quietThreadAtomFamily(key));
      return thread === null ? EMPTY_VISIBLE_TURN_ITEMS : projectQuestionHistory(thread.projection);
    }).pipe(
      Atom.setIdleTTL(0),
      Atom.withLabel(`environment-quiet-thread-visible-turn-items:${key}`),
    );
  });

  const queueWorkflowAtomFamily = Atom.family((key: string) => {
    let previous: Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "runs" | "messages" | "providerThreads" | "providerSessions" | "providerTurns"
    > | null = null;
    let value: ThreadQueueWorkflowState | null = null;
    return Atom.make((get) => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (projection === null) {
        previous = null;
        value = null;
      } else if (
        previous === null ||
        projection.thread !== previous.thread ||
        projection.runs !== previous.runs ||
        projection.messages !== previous.messages ||
        projection.providerThreads !== previous.providerThreads ||
        projection.providerSessions !== previous.providerSessions ||
        projection.providerTurns !== previous.providerTurns
      ) {
        value = deriveThreadQueueWorkflowState(projection);
        const { thread, runs, messages, providerThreads, providerSessions, providerTurns } =
          projection;
        previous = { thread, runs, messages, providerThreads, providerSessions, providerTurns };
      }
      return value;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-queue:${key}`));
  });
  const queuedCountAtomFamily = Atom.family((key: string) => {
    let previous: Pick<OrchestrationV2ThreadProjection, "runs" | "messages"> | null = null;
    let count = 0;
    return Atom.make((get) => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (projection === null) {
        previous = null;
        count = 0;
      } else if (projection.runs !== previous?.runs || projection.messages !== previous?.messages) {
        const { runs, messages } = projection;
        previous = { runs, messages };
        count = getUserQueuedThreadRuns(previous).length;
      }
      return count;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-queue-count:${key}`));
  });

  const turnSubagentsAtomFamily = Atom.family((key: string) => {
    let previous: Pick<OrchestrationV2ThreadProjection, "runs" | "subagents"> | null = null;
    let value: ThreadTurnSubagents | null = null;
    return Atom.make((get) => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (projection === null) {
        previous = null;
        value = null;
      } else if (
        projection.runs !== previous?.runs ||
        projection.subagents !== previous?.subagents
      ) {
        const { runs, subagents } = projection;
        previous = { runs, subagents };
        value = deriveThreadTurnSubagents(previous);
      }
      return value;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-turn-subagents:${key}`));
  });

  const checkpointSummariesAtomFamily = Atom.family((key: string) => {
    let previous: Pick<OrchestrationV2ThreadProjection, "checkpoints" | "messages"> | null = null;
    let value = EMPTY_CHECKPOINT_SUMMARIES;
    return Atom.make((get) => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (projection === null) {
        previous = null;
        value = EMPTY_CHECKPOINT_SUMMARIES;
      } else if (
        projection.checkpoints !== previous?.checkpoints ||
        projection.messages !== previous?.messages
      ) {
        const { checkpoints, messages } = projection;
        previous = { checkpoints, messages };
        value = deriveThreadCheckpointSummaries(previous);
      }
      return value;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-checkpoint-summaries:${key}`));
  });

  const worktreePathAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get) =>
        Option.getOrNull(get(threadStateValueAtomFamily(key)).data)?.thread.worktreePath ?? null,
    ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-worktree:${key}`)),
  );
  const pendingRequestsAtomFamily = Atom.family((key: string) => {
    let previous: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems"> | null =
      null;
    let value: PendingThreadRequests | null = null;
    return Atom.make((get) => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (projection === null) {
        previous = null;
        value = null;
        return value;
      }
      const runtimeRequests = projection.runtimeRequests.filter(
        (request) => request.status === "pending",
      );
      const ids = new Set(runtimeRequests.map((request) => request.id));
      const turnItems =
        ids.size === 0
          ? []
          : projection.turnItems.filter(
              (item) =>
                (item.type === "approval_request" || item.type === "user_input_request") &&
                ids.has(item.requestId),
            );
      if (
        previous === null ||
        !arrayElementsEqual(previous.runtimeRequests, runtimeRequests) ||
        !arrayElementsEqual(previous.turnItems, turnItems)
      ) {
        previous = { runtimeRequests, turnItems };
        value = derivePendingThreadRequests(previous);
      }
      return value;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-pending-requests:${key}`));
  });

  const statusAtomFamily = Atom.family((key: string) =>
    Atom.make((get) => get(threadStateValueAtomFamily(key)).status).pipe(
      Atom.setIdleTTL(0),
      Atom.withLabel(`environment-thread-status:${key}`),
    ),
  );
  const errorAtomFamily = Atom.family((key: string) =>
    Atom.make((get) => Option.getOrNull(get(threadStateValueAtomFamily(key)).error)).pipe(
      Atom.setIdleTTL(0),
      Atom.withLabel(`environment-thread-error:${key}`),
    ),
  );
  const historyAtomFamily = Atom.family((key: string) =>
    Atom.make((get) => get(threadStateValueAtomFamily(key)).history).pipe(
      Atom.setIdleTTL(0),
      Atom.withLabel(`environment-thread-history:${key}`),
    ),
  );

  return {
    worktreePathAtom: (ref: ScopedThreadRef) => worktreePathAtomFamily(threadKey(ref)),
    pendingRequestsAtom: (ref: ScopedThreadRef) => pendingRequestsAtomFamily(threadKey(ref)),
    queueWorkflowAtom: (ref: ScopedThreadRef) => queueWorkflowAtomFamily(threadKey(ref)),
    queuedCountAtom: (ref: ScopedThreadRef) => queuedCountAtomFamily(threadKey(ref)),
    turnSubagentsAtom: (ref: ScopedThreadRef) => turnSubagentsAtomFamily(threadKey(ref)),
    checkpointSummariesAtom: (ref: ScopedThreadRef) =>
      checkpointSummariesAtomFamily(threadKey(ref)),
    stateAtom: (ref: ScopedThreadRef) => threadStateValueAtomFamily(threadKey(ref)),
    threadAtom: (ref: ScopedThreadRef) => threadAtomFamily(threadKey(ref)),
    quietThreadAtom: (ref: ScopedThreadRef) => quietThreadAtomFamily(threadKey(ref)),
    visibleTurnItemsAtom: (ref: ScopedThreadRef) => visibleTurnItemsAtomFamily(threadKey(ref)),
    quietVisibleTurnItemsAtom: (ref: ScopedThreadRef) =>
      quietVisibleTurnItemsAtomFamily(threadKey(ref)),
    statusAtom: (ref: ScopedThreadRef) => statusAtomFamily(threadKey(ref)),
    errorAtom: (ref: ScopedThreadRef) => errorAtomFamily(threadKey(ref)),
    historyAtom: (ref: ScopedThreadRef) => historyAtomFamily(threadKey(ref)),
  };
}
