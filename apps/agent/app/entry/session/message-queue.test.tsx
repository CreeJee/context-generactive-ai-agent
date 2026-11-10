import { it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import { isTruthy } from "../../truthy.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, vi } from "vite-plus/test";
import type { QueueSnapshot } from "../api";
import { api, NextDelivery, QueueEdit, QueueItemState } from "../api";
import { SessionEventScopeContext } from "../events/context";
import { appQueryKeys } from "../events/query-keys";
import { useMessageQueue } from "./message-queue";

const sdkCall = Effect.fn("sessionHook.sdkCall")(function* <A>(
  operation: () => A | PromiseLike<A>,
) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});

const projectId = "project-1";
const sessionId = "session-1";
const key = appQueryKeys.session.queue(projectId, sessionId);
const item: QueueSnapshot["items"][number] = {
  id: "queued-1",
  seq: 1,
  text: "queued text",
  attachmentIds: [],
  state: QueueItemState.waiting({ steered: false }),
  createdAt: 1,
};

function readSnapshot(snapshot: QueueSnapshot) {
  const client = new QueryClient();
  client.setQueryData(key, snapshot);
  const captured: ReturnType<typeof useMessageQueue>[] = [];
  function Probe() {
    captured.push(useMessageQueue(sessionId, "holder", false));
    return null;
  }
  renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <SessionEventScopeContext.Provider value={{ projectId, sessionId }}>
        <Probe />
      </SessionEventScopeContext.Provider>
    </QueryClientProvider>,
  );
  const current = captured[0];
  if (!isTruthy(current)) throw new Error("Missing queue result");
  return current;
}

afterEach(() => vi.restoreAllMocks());

describe("queue snapshot from server", () => {
  it.live("a queue edit fetches the latest complete server snapshot", () =>
    Effect.gen(function* () {
      const updated: QueueSnapshot = {
        items: [{ ...item, state: QueueItemState.held({ draft: null }) }],
        nextDelivery: NextDelivery.blocked({ messageId: item.id, reason: "held" }),
      };
      vi.spyOn(api, "editQueued").mockResolvedValue(null);
      const read = vi.spyOn(api, "queue").mockResolvedValue(updated);
      const queue = readSnapshot({
        items: [item],
        nextDelivery: NextDelivery.server(),
      });
      // The change went through, so there is no reason to show, and the queue is read again.
      expect(
        yield* sdkCall(() => queue.change(item.id, QueueEdit.edit({ draft: item.text }))),
      ).toBeNull();
      expect(read).toHaveBeenCalled();
    }),
  );
});
