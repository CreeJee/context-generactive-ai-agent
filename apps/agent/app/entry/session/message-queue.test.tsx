import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { QueueSnapshot } from "../api";
import { api } from "../api";
import { SessionEventScopeContext } from "../events/context";
import { appQueryKeys } from "../events/query-keys";
import { useMessageQueue } from "./message-queue";

const projectId = "project-1";
const sessionId = "session-1";
const key = appQueryKeys.session.queue(projectId, sessionId);
const item: QueueSnapshot["items"][number] = {
  id: "queued-1",
  seq: 1,
  text: "queued text",
  attachmentIds: [],
  state: { kind: "waiting" },
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
  if (!current) throw new Error("Missing queue result");
  return current;
}

afterEach(() => vi.restoreAllMocks());

describe("queue snapshot from server", () => {
  test("passes through server readiness rather than interpreting waiting item states", () => {
    const blocked = readSnapshot({
      items: [item],
      nextDelivery: { kind: "blocked", messageId: item.id, reason: "held" },
    });
    expect(blocked.items).toEqual([item]);
    expect(blocked.nextDelivery).toEqual({ kind: "blocked", messageId: item.id, reason: "held" });

    const ready = readSnapshot({
      items: [item],
      nextDelivery: { kind: "ready" },
    });
    expect(ready.nextDelivery).toEqual({ kind: "ready" });
  });

  test("a queue edit fetches the latest complete server snapshot", async () => {
    const updated: QueueSnapshot = {
      items: [{ ...item, state: { kind: "held", draft: null } }],
      nextDelivery: { kind: "blocked", messageId: item.id, reason: "held" },
    };
    vi.spyOn(api, "editQueued").mockResolvedValue(null);
    vi.spyOn(api, "queue").mockResolvedValue(updated);
    const queue = readSnapshot({
      items: [item],
      nextDelivery: { kind: "ready" },
    });
    expect(await queue.change(item.id, { action: "edit", draft: item.text })).toEqual(updated);
  });
});
