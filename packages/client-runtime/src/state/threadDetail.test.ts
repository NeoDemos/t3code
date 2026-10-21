import { MessageId, RunId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { v2Now, v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { onlyStreamedTextChanged } from "./threadDetail.ts";

const later = DateTime.makeUnsafe("2026-06-20T00:00:01.000Z");

const assistant: OrchestrationV2TurnItem = {
  id: TurnItemId.make("item-assistant"),
  threadId: v2ThreadId,
  runId: RunId.make("run-1"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "running",
  title: null,
  startedAt: v2Now,
  completedAt: null,
  updatedAt: v2Now,
  type: "assistant_message",
  messageId: MessageId.make("message-assistant"),
  text: "Hel",
  streaming: true,
};

function withItem(item: OrchestrationV2TurnItem, updatedAt = v2Now) {
  return {
    ...v2Projection,
    turnItems: [item],
    visibleTurnItems: [
      {
        position: 0,
        visibility: "local" as const,
        sourceThreadId: v2ThreadId,
        sourceItemId: item.id,
        item,
      },
    ],
    updatedAt,
  };
}

describe("onlyStreamedTextChanged", () => {
  const before = withItem(assistant);

  it("holds through streamed text", () => {
    const next = withItem({ ...assistant, text: "Hello", updatedAt: later }, later);
    expect(onlyStreamedTextChanged(before, next)).toBe(true);
  });

  it("sees the item finish streaming", () => {
    const next = withItem({ ...assistant, text: "Hello", streaming: false, status: "completed" });
    expect(onlyStreamedTextChanged(before, next)).toBe(false);
  });

  it("sees a new item", () => {
    const next = { ...before, turnItems: [assistant, { ...assistant, id: TurnItemId.make("b") }] };
    expect(onlyStreamedTextChanged(before, next)).toBe(false);
  });

  it("sees other fields change on a streaming item", () => {
    const next = withItem({ ...assistant, text: "Hello", title: "Answer" });
    expect(onlyStreamedTextChanged(before, next)).toBe(false);
  });

  it("sees changes outside the turn items", () => {
    expect(onlyStreamedTextChanged(before, { ...before, runs: [] })).toBe(false);
  });
});
