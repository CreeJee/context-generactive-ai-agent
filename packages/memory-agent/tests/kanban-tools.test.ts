import { Effect, Option } from "effect";
import { expect } from "vite-plus/test";
import type { JsonValue } from "../src/json.ts";
import { verdictRecorder } from "../src/kanban/subagent-card-agent.ts";
import { KanbanTools } from "../src/kanban/tools.ts";
import { CardVerdict } from "../src/kanban/card-agent.ts";
import { VerdictFailure } from "../src/kanban/failures.ts";
import { TestEnv, testAgent } from "./support/test-env.ts";

testAgent()("kanban tools", (it) => {
  it.effect("a session whose Goal is not a board: the read says so, a change is refused", () =>
    Effect.gen(function* () {
      const { session } = yield* TestEnv;
      const tools = (yield* KanbanTools).toolsFor(session.id, "run-1");
      const call = (index: number, params: JsonValue) =>
        Effect.flatMap(Effect.fromNullishOr(tools[index]), (tool) => tool.prepare(params)).pipe(
          Effect.flatMap((run) => run({ toolCallId: "call-1" })),
        );
      expect(yield* call(0, {})).toEqual({ error: "not_kanban" });
      expect(yield* call(1, { edit: { _tag: "Cancel", cardId: "missing" } })).toEqual({
        error: "kanban_action_refused",
        reason: "not_kanban",
      });
    }),
  );

  it.effect("record_card_verdict records the verifier's verdict", () =>
    Effect.gen(function* () {
      const recorded = Effect.fnUntraced(function* (params: JsonValue) {
        const recorder = yield* verdictRecorder;
        const run = yield* Effect.orDie(recorder.runTool.prepare(params));
        expect(yield* Effect.orDie(run({ toolCallId: "call-1" }))).toEqual({ recorded: true });
        return yield* recorder.verdict;
      });
      expect(yield* recorded({ passed: true, evidence: ["tests pass"] })).toEqual(
        Option.some(CardVerdict.Passed({ evidence: ["tests pass"] })),
      );
      expect(yield* recorded({ passed: false, evidence: ["a", "b"] })).toEqual(
        Option.some(
          CardVerdict.Failed({ failure: VerdictFailure.cases.Rejected.make({ note: "a; b" }) }),
        ),
      );
      expect(yield* recorded({ passed: false, evidence: ["a"], reason: "missing docs" })).toEqual(
        Option.some(
          CardVerdict.Failed({
            failure: VerdictFailure.cases.Rejected.make({ note: "missing docs" }),
          }),
        ),
      );
    }),
  );
});
