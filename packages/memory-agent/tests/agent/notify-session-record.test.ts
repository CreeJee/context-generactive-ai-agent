import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { Nodes, Recorder, SessionDispatches, Sessions } from "memory-agent";
import { scriptedRun } from "../support/loop-run.ts";
import { sqlGet } from "../support/sql.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";

/** The `notify_session` tool of one run, bound like chat.ts binds it. */
const notifyToolFor = (projectId: string, sessionId: string) =>
  Effect.map(SessionDispatches, (dispatches) =>
    dispatches.notifyToolFor(projectId, sessionId, "run-1"),
  );

/** A fresh session whose user node starts the run, as chat.ts records it. */
const userTurn = Effect.fnUntraced(function* (text: string) {
  const { project } = yield* TestEnv;
  const session = yield* (yield* Sessions).create(project.id);
  const user = yield* (yield* Nodes).append({
    projectId: project.id,
    sessionId: session.id,
    kind: "user",
    text,
  });
  return { project, session, user };
});

testAgent()(function (it) {
  it.effect("a chat run records the notify_session call and its result", () =>
    Effect.gen(function* () {
      const { project, session, user } = yield* userTurn("다른 대화에 남겨 줘.");
      const other = yield* (yield* Sessions).create(project.id);
      const tools = yield* notifyToolFor(project.id, session.id);
      const runId = `${session.id}:run`;
      yield* scriptedRun({
        turns: [
          {
            text: "다른 대화에 남겨 둘게요.",
            toolCalls: [
              {
                id: "call-1",
                name: "notify_session",
                arguments: JSON.stringify({ toSession: other.id, body: "아까 그 안건 보내요" }),
              },
            ],
          },
          { text: "남겼습니다." },
        ],
        runId,
        conversation: [{ role: "user", content: user.text }],
        tools: [tools],
        hooks: [
          yield* (yield* Recorder).hookFor({
            projectId: project.id,
            sessionId: session.id,
            runId,
            replyTo: Effect.succeedSome(user.id),
          }),
        ],
      });

      const nodes = yield* Nodes;
      const stored = yield* nodes.session(session.id);
      const call = stored.find(
        (node) => node.kind === "tool_call" && node.detail?.toolName === "notify_session",
      );
      expect(call).toMatchObject({
        text: `notify_session ${JSON.stringify({
          toSession: other.id,
          body: "아까 그 안건 보내요",
        })}`,
        detail: { toolName: "notify_session", toolCallId: "call-1" },
      });
      const result = stored.find(
        (node) => node.kind === "tool_result" && node.detail?.toolName === "notify_session",
      );
      expect(result).toMatchObject({
        detail: { toolName: "notify_session", toolCallId: "call-1", ok: true },
      });
      // The recorded result carries the stored dispatch, and the row waits.
      expect(result?.text).toContain(other.id);
      expect(
        yield* sqlGet("SELECT state FROM session_dispatches WHERE to_session_id = ?", other.id),
      ).toEqual({ state: "waiting" });
    }),
  );

  it.effect("a refused call is recorded as a failed tool result", () =>
    Effect.gen(function* () {
      const { project, session, user } = yield* userTurn("남겨 줘.");
      const tools = yield* notifyToolFor(project.id, session.id);
      const runId = `${session.id}:run`;
      yield* scriptedRun({
        turns: [
          {
            toolCalls: [
              {
                id: "call-2",
                name: "notify_session",
                arguments: JSON.stringify({ toSession: "no-such-session", body: "hi" }),
              },
            ],
          },
          { text: "실패했네요." },
        ],
        runId,
        conversation: [{ role: "user", content: user.text }],
        tools: [tools],
        hooks: [
          yield* (yield* Recorder).hookFor({
            projectId: project.id,
            sessionId: session.id,
            runId,
            replyTo: Effect.succeedSome(user.id),
          }),
        ],
      });
      const nodes = yield* Nodes;
      const stored = yield* nodes.session(session.id);
      const result = stored.find(
        (node) => node.kind === "tool_result" && node.detail?.toolName === "notify_session",
      );
      expect(result).toMatchObject({
        text: expect.stringContaining("notify_unknown_target"),
        detail: { toolName: "notify_session", toolCallId: "call-2", ok: false },
      });
      expect(
        yield* sqlGet(
          "SELECT count(*) AS rows FROM session_dispatches WHERE to_session_id = ?",
          "no-such-session",
        ),
      ).toEqual({ rows: 0 });
    }),
  );
});
