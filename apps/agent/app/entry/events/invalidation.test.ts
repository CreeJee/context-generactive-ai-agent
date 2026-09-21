import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createInvalidationBatch } from "./invalidation";
import { appQueryKeys } from "./query-keys";

afterEach(() => vi.useRealTimers());

describe("createInvalidationBatch", () => {
  test("ready immediately repairs the snapshot/open race", () => {
    const invalidate = vi.fn();
    const root = appQueryKeys.session.root("p1", "s1");
    const batch = createInvalidationBatch(invalidate, root);
    batch.ready();
    expect(invalidate).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith(root);
  });

  test("coalesces a burst by topic and ignores duplicate revisions", () => {
    vi.useFakeTimers();
    const invalidate = vi.fn();
    const batch = createInvalidationBatch(invalidate, appQueryKeys.session.root("p1", "s1"));
    const queue = {
      scope: "session" as const,
      projectId: "p1",
      sessionId: "s1",
      topic: "queue" as const,
      revision: 7,
    };
    batch.changed(queue);
    batch.changed(queue);
    batch.changed({ ...queue, revision: 8 });
    expect(invalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith(appQueryKeys.session.queue("p1", "s1"));
    batch.close();
  });
});
