import { DateTime, Effect } from "effect";
import { expect } from "vite-plus/test";
import { sessionMessages } from "../../src/agent/history.ts";
import { Database } from "../../src/db/database.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";

/** A new session of the given origin with one user message appended. */
const sessionWithMessage = Effect.fnUntraced(function* (
  origin: "new" | "named" | "imported",
  text: string,
) {
  const { project } = yield* TestEnv;
  const sessions = yield* Sessions;
  const session = yield* (() => {
    switch (origin) {
      case "new":
        return sessions.create(project.id);
      case "named":
        return sessions.create(project.id, "직접 지정");
      case "imported":
        return Effect.flatMap(DateTime.now, (now) =>
          sessions.createImported(project.id, null, DateTime.formatIso(now), "codex", {
            worktreePath: null,
            branch: null,
          }),
        );
    }
  })();
  (yield* Nodes).append({ projectId: project.id, sessionId: session.id, kind: "user", text });
  return session.id;
});

testAgent()("session history", (it) => {
  it.effect("groups a run's text, tool calls and results into one assistant message", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      const sessionId = (yield* (yield* Sessions).create(project.id)).id;
      const nodes = yield* Nodes;
      const at = { projectId: project.id, sessionId };
      const runId = `${sessionId}-r1`;
      const user = nodes.append({ ...at, kind: "user", text: "DB 뭐로 했지?" });
      const empty = nodes.append({ ...at, runId, kind: "assistant", text: "" });
      nodes.append({
        ...at,
        runId,
        kind: "tool_call",
        text: 'find_memory {"query":"DB"}',
        detail: { toolName: "find_memory", toolCallId: "c1" },
      });
      nodes.append({
        ...at,
        runId,
        kind: "tool_result",
        text: '{"matches":[]}',
        detail: { toolName: "find_memory", toolCallId: "c1", ok: true },
      });
      nodes.append({ ...at, runId, kind: "assistant", text: "SQLite로 했어요." });
      nodes.append({ ...at, kind: "user", text: "고마워" });

      const messages = sessionMessages(nodes.session(sessionId), () => []);
      expect(messages.map((message) => [message.role, message.parts])).toEqual([
        ["user", [{ type: "text", content: "DB 뭐로 했지?" }]],
        [
          "assistant",
          [
            {
              type: "tool-call",
              id: "c1",
              name: "find_memory",
              arguments: '{"query":"DB"}',
              state: "input-complete",
            },
            { type: "tool-result", toolCallId: "c1", content: '{"matches":[]}', state: "complete" },
            { type: "text", content: "SQLite로 했어요." },
          ],
        ],
        ["user", [{ type: "text", content: "고마워" }]],
      ]);
      expect(messages[0]!.id).toBe(user.id);
      expect(messages[1]!.id).toBe(empty.id);
    }),
  );

  it.effect.each([
    { origin: "new", text: "  첫 질문\n  입니다  ", title: "첫 질문 입니다" },
    { origin: "new", text: "😀".repeat(61), title: "😀".repeat(60) + "…" },
    { origin: "new", text: "", title: "이미지 대화" },
    { origin: "named", text: "바꾸지 않음", title: "직접 지정" },
    { origin: "imported", text: "가져온 대화", title: null },
  ] as const)(
    "the first user message of a $origin session leaves the title $title",
    ({ origin, text, title }) =>
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const sessionId = yield* sessionWithMessage(origin, text);
        expect((yield* sessions.get(sessionId)).title).toBe(title);
        // Later messages never rename it.
        (yield* Nodes).append({
          projectId: (yield* TestEnv).project.id,
          sessionId,
          kind: "user",
          text: "다음 질문",
        });
        expect((yield* sessions.get(sessionId)).title).toBe(title);
      }),
  );

  it.effect(
    "old untitled conversations show their first message in active and archived lists",
    () =>
      Effect.gen(function* () {
        const { project } = yield* TestEnv;
        const sessions = yield* Sessions;
        const sessionId = yield* sessionWithMessage("new", "첫 번째 질문");
        (yield* Nodes).append({
          projectId: project.id,
          sessionId,
          kind: "user",
          text: "두 번째 질문",
        });
        // Simulate a conversation written before automatic titles existed.
        (yield* Database).sqlite
          .prepare("UPDATE sessions SET title = NULL WHERE id = ?")
          .run(sessionId);
        const titleIn = (list: readonly { readonly id: string; readonly title: string | null }[]) =>
          list.find((session) => session.id === sessionId)?.title;
        expect(titleIn(yield* sessions.list(project.id))).toBe("첫 번째 질문");
        expect((yield* sessions.get(sessionId)).title).toBe("첫 번째 질문");
        expect((yield* sessions.setArchived(sessionId, true)).title).toBe("첫 번째 질문");
        expect(titleIn(yield* sessions.list(project.id, true))).toBe("첫 번째 질문");
        const empty = yield* sessions.create(project.id);
        expect((yield* sessions.get(empty.id)).title).toBeNull();
      }),
  );
});
