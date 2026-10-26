import { Effect } from "effect";
import { expect } from "vite-plus/test";
import type { JsonValue } from "../src/json.ts";
import { verdictRecorder } from "../src/kanban/subagent-card-agent.ts";
import { KanbanTools } from "../src/kanban/tools.ts";
import { sdk } from "./agents/agent-env.ts";
import { runToolRequestDifferences } from "./support/requests.ts";
import { TestEnv, testAgent } from "./support/test-env.ts";

testAgent()("kanban tools", (it) => {
  it.effect("the Effect AI tools ask as the TanStack ones and answer the same", () =>
    Effect.gen(function* () {
      const { session } = yield* TestEnv;
      const kanban = yield* KanbanTools;
      const chatTools = kanban.forSession(session.id, "run-1");
      const runTools = kanban.runToolsFor(session.id, "run-1");
      expect(yield* runToolRequestDifferences({ chatTools, runTools })).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
      // A session whose Goal is not a board: the read says so, a change is refused.
      const calls: ReadonlyArray<readonly [number, JsonValue]> = [
        [0, {}],
        [1, { edit: { _tag: "Cancel", cardId: "missing" } }],
      ];
      for (const [index, params] of calls) {
        const tanstack = yield* sdk(() => chatTools[index]!.execute!(params));
        const run = yield* Effect.flatMap(Effect.fromNullishOr(runTools[index]), (tool) =>
          tool.prepare(params),
        );
        expect(yield* run({ toolCallId: "call-1" })).toEqual(tanstack);
      }
    }),
  );

  it.effect("a verifier's Effect AI record_card_verdict records as the TanStack one", () =>
    Effect.gen(function* () {
      const recorded = Effect.fnUntraced(function* <A>(
        record: (recorder: Effect.Success<typeof verdictRecorder>) => Effect.Effect<A>,
      ) {
        const recorder = yield* verdictRecorder;
        expect(yield* record(recorder)).toEqual({ recorded: true });
        return yield* recorder.verdict;
      });
      const probe = yield* verdictRecorder;
      expect(
        yield* runToolRequestDifferences({ chatTools: [probe.tool], runTools: [probe.runTool] }),
      ).toEqual([undefined, undefined, undefined]);
      for (const params of [
        { passed: true, evidence: ["tests pass"] },
        { passed: false, evidence: ["a", "b"] },
        { passed: false, evidence: ["a"], reason: "missing docs" },
      ])
        expect(
          yield* recorded((recorder) =>
            Effect.flatMap(Effect.orDie(recorder.runTool.prepare(params)), (run) =>
              Effect.orDie(run({ toolCallId: "call-1" })),
            ),
          ),
        ).toEqual(
          yield* recorded((recorder) => Effect.orDie(sdk(() => recorder.tool.execute!(params)))),
        );
    }),
  );
});
