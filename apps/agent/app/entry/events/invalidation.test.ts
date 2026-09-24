import { describe, expect, test, vi } from "vite-plus/test";
import { createEventInvalidator } from "./invalidation";
import { appQueryKeys } from "./query-keys";

describe("createEventInvalidator", () => {
  test("ready immediately repairs the snapshot/open race", () => {
    const invalidate = vi.fn();
    const root = appQueryKeys.session.root("p1", "s1");
    const invalidator = createEventInvalidator(invalidate, root);
    invalidator.ready(0);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith(root);
  });

  test("invalidates changed keys immediately and ignores duplicate revisions", () => {
    const invalidate = vi.fn();
    const invalidator = createEventInvalidator(invalidate, appQueryKeys.session.root("p1", "s1"));
    const queue = {
      scope: "session" as const,
      projectId: "p1",
      sessionId: "s1",
      topic: "queue" as const,
      revision: 7,
    };
    invalidator.changed(queue);
    invalidator.changed(queue);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith(appQueryKeys.session.queue("p1", "s1"));
    invalidator.ready(7);
    expect(invalidate).toHaveBeenCalledOnce();
    invalidator.ready(8);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});
