import { describe, expect, test } from "vite-plus/test";
import { appQueryKeys, invalidationKeys } from "./query-keys";

describe("hierarchical app query keys", () => {
  test("invalidates only the changed session resource", () => {
    expect(
      invalidationKeys({
        scope: "session",
        projectId: "p1",
        sessionId: "s1",
        topic: "queue",
        revision: 1,
      }),
    ).toEqual([appQueryKeys.session.queue("p1", "s1")]);
    expect(
      invalidationKeys({
        scope: "session",
        projectId: "p1",
        sessionId: "s1",
        topic: "queue",
        revision: 1,
      }),
    ).not.toContainEqual(appQueryKeys.session.queue("p1", "s2"));
  });

  test("uses scope roots for broad invalidation", () => {
    expect(
      invalidationKeys({
        scope: "session",
        projectId: "p1",
        sessionId: "s1",
        topic: "all",
        revision: 2,
      }),
    ).toEqual([appQueryKeys.session.root("p1", "s1")]);
    expect(
      invalidationKeys({ scope: "project", projectId: "p1", topic: "all", revision: 3 }),
    ).toEqual([appQueryKeys.project.root("p1")]);
    expect(invalidationKeys({ scope: "global", topic: "all", revision: 4 })).toEqual([
      appQueryKeys.global.root,
    ]);
  });

  test("maps project and global resources without crossing scopes", () => {
    expect(
      invalidationKeys({ scope: "project", projectId: "p1", topic: "sessions", revision: 1 }),
    ).toEqual([appQueryKeys.project.sessions("p1")]);
    expect(invalidationKeys({ scope: "global", topic: "embedding", revision: 1 })).toEqual([
      appQueryKeys.global.embedding,
    ]);
  });
});
