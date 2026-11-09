import { Duration, Effect, HashMap, Option, Ref, Schema } from "effect";
import { expect } from "vite-plus/test";
import {
  compactionHook,
  lookupSources,
  messageText,
  type StepsToSummarize,
} from "../../src/agent/compaction.ts";
import { stepSummaryPrompt } from "../../src/agent/step-summaries.ts";
import type { StoredMessage } from "../../src/chat-store/schema.ts";
import { RunStore } from "../../src/loop/store.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import type { ScriptedTurn } from "../../src/testing/scripted-model.ts";
import { runTool } from "../../src/tools/run-tool.ts";
import { scriptedRun } from "../support/loop-run.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { noLimit } from "./fixtures.ts";

const readFile = runTool({
  name: "read_file",
  description: "Read a project file",
  parameters: Schema.Struct({ path: Schema.String }),
  // About 1,000 tokens a result.
  handler: () => Effect.succeed({ content: "y".repeat(4_000) }),
});

const readCall = (step: number): ScriptedTurn => ({
  toolCalls: [{ id: `read-${step}`, name: "read_file", arguments: `{"path":"${step}.ts"}` }],
});

/** Forty-four steps that each read a file, then the answer. */
const turns: readonly [ScriptedTurn, ...Array<ScriptedTurn>] = [
  readCall(0),
  ...Array.from({ length: 43 }, (_, step) => readCall(step + 1)),
  { text: "다 읽었어요." },
];

const task = "파일들을 읽어 줘";

/** Sources whose outputs are read again by their call id, or by nothing. */
const sources = (rereadable: boolean) =>
  lookupSources({ toolResultId: (id) => (rereadable ? id : null), nodeText: () => null });

/**
 * Past 20,000 tokens of steps a block is due: by the thirtieth step, when the request would pass
 * 40,000 tokens as many steps later. The request past 40,000 tokens is compacted again, and sends
 * it.
 */
const leaveOutAt = 40_000;

/** One run under compaction whose step summaries `summarize` gives; what it asked, and was sent. */
const run = Effect.fnUntraced(function* (
  name: string,
  rereadable: boolean,
  summarize: Option.Option<string>,
  leaveOutAt: number,
) {
  const { project } = yield* TestEnv;
  const session = yield* (yield* Sessions).create(project.id);
  const asked = yield* Ref.make<ReadonlyArray<StepsToSummarize>>([]);
  const compacting = yield* compactionHook({
    sources: sources(rereadable),
    budget: { compactAt: 0, leaveOutAt, inputCeiling: noLimit },
    restore: () => Effect.succeed(null),
    promptCacheFor: Duration.hours(1),
    summarizeSteps: (steps) =>
      Effect.as(
        Ref.update(asked, (all) => [...all, steps]),
        summarize,
      ),
  });
  const conversation: ReadonlyArray<StoredMessage> = [{ role: "user", content: task }];
  const { invocations } = yield* scriptedRun({
    turns,
    runId: `${session.id}:${name}`,
    threadId: session.id,
    conversation,
    tools: [readFile],
    hooks: [compacting.hook],
  });
  return {
    asked: yield* Ref.get(asked),
    last: (yield* invocations).at(-1)?.history ?? [],
    stage: yield* compacting.stage,
    saved: yield* (yield* RunStore).thread(session.id),
  };
});

/** The id of the first call a sent message makes, if it makes one. */
const firstCall = (message: StoredMessage | undefined) =>
  message?.role === "assistant" ? message.toolCalls?.[0]?.id : undefined;

const resultOf = (history: ReadonlyArray<StoredMessage>, id: string) =>
  history.find((message) => message.role === "tool" && message.toolCallId === id);

testAgent()("step summaries", (it) => {
  it.effect("a long run's earlier steps are sent as their summary once it is compacted again", () =>
    Effect.gen(function* () {
      const { asked, last, stage, saved } = yield* run(
        "summarized",
        true,
        Option.some("- 요약"),
        leaveOutAt,
      );
      // One block: the first twenty steps, with the run's task and where to reread each output.
      expect(asked).toHaveLength(1);
      const [steps] = asked;
      expect(steps?.task).toBe(task);
      expect(steps?.messages).toHaveLength(40);
      expect(steps?.messages[0]?.toolCalls?.[0]?.id).toBe("read-0");
      expect(steps?.messages.at(-1)?.toolCallId).toBe("read-19");
      expect(Option.getOrUndefined(HashMap.get(steps?.rereads ?? HashMap.empty(), "read-19"))).toBe(
        "read_tool_result ID read-19, page by offset",
      );
      const prompt = stepSummaryPrompt(steps!);
      expect(prompt).toContain(task);
      expect(prompt).toContain("reread: read_tool_result ID read-0, page by offset");

      // The summary stands in for those steps, calls and results alike; the later steps stay.
      expect(last[0]).toEqual({ role: "user", content: task });
      expect(last[1]?.role).toBe("assistant");
      expect(last[1]?.content).toContain("[Summary of steps 1-20 of this run");
      expect(last[1]?.content).toContain("- 요약");
      expect(firstCall(last[2])).toBe("read-20");
      expect(resultOf(last, "read-19")).toBeUndefined();
      expect(resultOf(last, "read-43")?.content).toContain("y".repeat(4_000));
      expect(stage).toBe("summarize");
      // The saved run keeps every step.
      expect(resultOf(saved, "read-0")?.content).toContain("y".repeat(4_000));
    }),
  );

  it.effect("a summary that could not be made is not asked for again in the run", () =>
    Effect.gen(function* () {
      const { asked, last } = yield* run("failed", true, Option.none(), leaveOutAt);
      expect(asked).toHaveLength(1);
      expect(last.some((message) => messageText(message).includes("[Summary of steps"))).toBe(
        false,
      );
      expect(firstCall(last[1])).toBe("read-0");
    }),
  );

  it.effect("a run that ends before its request would be compacted again asks for no summary", () =>
    Effect.gen(function* () {
      // About 45,000 tokens at the end: steps are due past 40,000, but 20 more would not pass 80,000.
      const { asked } = yield* run("short", true, Option.some("- 요약"), 80_000);
      expect(asked).toEqual([]);
    }),
  );

  it.effect("steps whose outputs cannot be read again are not summarized away", () =>
    Effect.gen(function* () {
      const { asked } = yield* run("unrecorded", false, Option.some("- 요약"), leaveOutAt);
      expect(asked).toEqual([]);
    }),
  );
});
