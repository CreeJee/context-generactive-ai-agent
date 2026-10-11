import { selectTestModel } from "./support/provider.ts";
import { it } from "@effect/vitest";
import { Effect, Exit, Scope, Schema } from "effect";
import { expect } from "vite-plus/test";
import { makeAgentChatImplementation } from "../src/agent/chat.ts";
import type { RecallSensorInput, RecallSensorResult } from "../src/agent/recall-sensor.ts";
import { Database } from "../src/db/database.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { testRuntime } from "./support/runtime.ts";

const outcomes: RecallSensorResult[] = [
  { status: "evaluated", version: "synthetic-node", score: 1 },
  ...(["disabled", "skipped", "unavailable", "timeout", "cancelled", "error"] as const).map(
    (status): RecallSensorResult => ({ status, version: "synthetic-node" }),
  ),
];

it.live.each(outcomes)(
  "shadow $status leaves provider input and original evidence unchanged",
  (outcome) =>
    Effect.gen(function* () {
      const context = yield* Effect.promise(() =>
        testRuntime({
          testProvider: { responder: () => ({ text: "합계는 9입니다." }) },
        }),
      );
      yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
      const original = yield* Effect.provideContext(
        Effect.map(Nodes, (nodes) =>
          nodes.append({
            projectId: context.project.id,
            sessionId: context.session.id,
            kind: "user",
            text: "SYNTHETIC_PRIVATE_PRIOR: 샘플 색상은 호박색이다.",
          }),
        ),
        yield* context.runtime.contextEffect,
      );
      const observed: RecallSensorInput[] = [];
      const sensor = {
        evaluate: (input: RecallSensorInput) => {
          observed.push(input);
          return Promise.resolve(outcome);
        },
      };
      const scope = yield* Effect.provideContext(
        Scope.make(),
        yield* context.runtime.contextEffect,
      );
      try {
        const agent = yield* Effect.provideContext(
          makeAgentChatImplementation(sensor).pipe(Effect.provideService(Scope.Scope, scope)),
          yield* context.runtime.contextEffect,
        );
        const incoming = "4와 5를 더해 줘. 합계만 답해 줘.";
        const response = yield* Effect.provideContext(
          agent.handle(
            new Request("http://127.0.0.1/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                threadId: "shadow-thread",
                runId: `shadow-${outcome.status}`,
                messages: [{ id: "m1", role: "user", content: incoming }],
                tools: [],
                context: [],
              }),
            }),
            context.session.id,
          ),
          yield* context.runtime.contextEffect,
        );
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.text())).toContain("합계는 9입니다.");
        expect(observed).toHaveLength(1);
        expect(observed[0]!.redactedText).toBe(incoming);
        const invocations = context.provider!.adapter.invocations;
        expect(invocations).toHaveLength(1);
        expect(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            invocations[0]!.messages,
          ),
        ).not.toContain("SYNTHETIC_PRIVATE_PRIOR");
        expect(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            invocations[0]!.messages,
          ),
        ).not.toContain("synthetic-node");
        expect(invocations[0]!.messages.map((message) => message.role)).toEqual(["user"]);
        const stored = yield* Effect.provideContext(
          Effect.map(Database, ({ sqlite }) => ({
            original: sqlite.prepare("SELECT text FROM nodes WHERE id = ?").get(original.id)?.text,
            calls: sqlite.prepare("SELECT count(*) AS n FROM nodes WHERE kind = 'tool_call'").get()
              ?.n,
          })),
          yield* context.runtime.contextEffect,
        );
        expect(stored).toEqual({ original: original.text, calls: 0 });
      } finally {
        yield* Effect.provideContext(
          Scope.close(scope, Exit.void),
          yield* context.runtime.contextEffect,
        );
      }
    }),
);
