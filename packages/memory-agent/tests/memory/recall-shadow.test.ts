import { Cause, Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import { makeAgentChatImplementation } from "../../src/agent/chat.ts";
import type { RecallSensorInput, RecallSensorResult } from "../../src/agent/recall-sensor.ts";
import { Database } from "../../src/db/database.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { selectTestModel } from "../support/provider.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const outcomes: RecallSensorResult[] = [
  { status: "evaluated", version: "synthetic-node", score: 1 },
  ...(["disabled", "skipped", "unavailable", "timeout", "cancelled", "error"] as const).map(
    (status): RecallSensorResult => ({ status, version: "synthetic-node" }),
  ),
];

testAgent({ testProvider: { responder: () => ({ text: "합계는 9입니다." }) } })(
  "recall shadow sensor in chat",
  (it) => {
    it.effect.each(outcomes)(
      "shadow $status leaves provider input and original evidence unchanged",
      (outcome) =>
        Effect.gen(function* () {
          const env = yield* TestEnv;
          yield* selectTestModel();
          const session = (yield* (yield* Sessions).create(env.project.id)).id;
          const original = (yield* Nodes).append({
            projectId: env.project.id,
            sessionId: session,
            kind: "user",
            text: "SYNTHETIC_PRIVATE_PRIOR: 샘플 색상은 호박색이다.",
          });
          const observed: RecallSensorInput[] = [];
          const agent = yield* makeAgentChatImplementation({
            evaluate: (input: RecallSensorInput) => {
              observed.push(input);
              return Promise.resolve(outcome);
            },
          });
          const incoming = "4와 5를 더해 줘. 합계만 답해 줘.";
          const response = yield* agent.handle(
            new Request("http://127.0.0.1/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: yield* encodeJson({
                threadId: session,
                runId: `${session}:shadow-${outcome.status}`,
                messages: [{ id: "m1", role: "user", content: incoming }],
                tools: [],
                context: [],
              }),
            }),
            session,
          );
          expect(response.status).toBe(200);
          expect(
            yield* Effect.tryPromise({
              try: () => response.text(),
              catch: (cause) => new Cause.UnknownError(cause),
            }),
          ).toContain("합계는 9입니다.");
          expect(observed).toHaveLength(1);
          expect(observed[0]!.redactedText).toBe(incoming);
          const invocations = env.provider!.adapter.invocations.filter(
            (turn) => turn.threadId === session,
          );
          expect(invocations).toHaveLength(1);
          const sent = yield* encodeJson(invocations[0]!.messages);
          expect(sent).not.toContain("SYNTHETIC_PRIVATE_PRIOR");
          expect(sent).not.toContain("synthetic-node");
          expect(invocations[0]!.messages.map((message) => message.role)).toEqual(["user"]);
          const { sqlite } = yield* Database;
          expect({
            original: sqlite.prepare("SELECT text FROM nodes WHERE id = ?").get(original.id)?.text,
            calls: sqlite
              .prepare(
                "SELECT count(*) AS n FROM nodes WHERE kind = 'tool_call' AND session_id = ?",
              )
              .get(session)?.n,
          }).toEqual({ original: original.text, calls: 0 });
        }),
    );
  },
);
