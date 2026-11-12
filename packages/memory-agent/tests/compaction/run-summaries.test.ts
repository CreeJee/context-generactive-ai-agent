import { Duration, Effect, HashMap, Option, Ref, Schema } from "effect";
import { expect } from "vite-plus/test";
import {
  compactionHook,
  type ConversationMessage,
  lookupSources,
  messageText,
  type SummaryRequest,
} from "../../src/agent/compaction.ts";
import { summaryFailureLimit } from "../../src/agent/compaction-policy.ts";
import { summaryPrompt } from "../../src/agent/session-summary.ts";
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
 * Past 4,000 tokens a request comes down to 2,000: the latest ten steps' calls and pointers, the
 * last result and the task take most of it, so the steps before them are left out as the run goes.
 */
const leaveOutAt = 4_000;

/**
 * One run under compaction whose summaries `summarize` gives by attempt, from 0; what it asked,
 * and was sent.
 */
const run = Effect.fnUntraced(function* (
  name: string,
  rereadable: boolean,
  summarize: (attempt: number) => Option.Option<string>,
  leaveOutAt: number,
) {
  const { project } = yield* TestEnv;
  const session = yield* (yield* Sessions).create(project.id);
  const asked = yield* Ref.make<ReadonlyArray<SummaryRequest>>([]);
  const compacting = yield* compactionHook({
    sources: sources(rereadable),
    budget: { compactAt: 0, leaveOutAt, inputCeiling: noLimit },
    restore: () => Effect.succeed(null),
    promptCacheFor: Duration.hours(1),
    summarize: (request) => Ref.modify(asked, (all) => [summarize(all.length), [...all, request]]),
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
  const store = yield* RunStore;
  return {
    asked: yield* Ref.get(asked),
    last: (yield* invocations).at(-1)?.history ?? [],
    stage: yield* compacting.stage,
    saved: yield* store.thread(session.id),
    summary: yield* store.chatMetadata.summary(session.id),
  };
});

/** The id of the first call a sent message makes, if it makes one. */
const firstCall = (message: ConversationMessage | undefined) =>
  message?.role === "assistant" ? message.toolCalls?.[0]?.id : undefined;

const resultOf = (history: ReadonlyArray<StoredMessage>, id: string) =>
  history.find((message) => message.role === "tool" && message.toolCallId === id);

const calls = (history: ReadonlyArray<StoredMessage>) =>
  history.flatMap((message) => Option.toArray(Option.fromNullishOr(firstCall(message))));

testAgent()("run summaries", (it) => {
  it.effect("a long run's older steps are summarized into the session's summary as they go", () =>
    Effect.gen(function* () {
      const { asked, last, stage, saved, summary } = yield* run(
        "summarized",
        true,
        (attempt) => Option.some(`- 요약 ${attempt}`),
        leaveOutAt,
      );
      // The first summary reads from the run's task on, with where to reread each output; each
      // later one folds in the summary so far.
      expect(asked.length).toBeGreaterThan(1);
      const [first, second] = asked;
      expect(first?.previous).toEqual(Option.none());
      expect(first?.messages[0]).toEqual({ role: "user", content: task });
      expect(firstCall(first?.messages[1])).toBe("read-0");
      expect(Option.getOrUndefined(HashMap.get(first?.rereads ?? HashMap.empty(), "read-0"))).toBe(
        "read_evidence read-0",
      );
      const prompt = summaryPrompt(first!);
      expect(prompt).toContain(task);
      expect(prompt).toContain("reread: read_evidence read-0");
      expect(second?.previous).toEqual(Option.some("- 요약 0"));
      expect(summaryPrompt(second!)).toContain("Summary so far:\n- 요약 0");

      // The summary stands in for those steps, calls and results alike. The task and the latest
      // ten steps stay, and the last step's result is whole.
      expect(last[0]?.role).toBe("assistant");
      expect(last[0]?.content).toContain("[Summary of the earlier conversation");
      expect(last[0]?.content).toContain(`- 요약 ${asked.length - 1}`);
      expect(last).toContainEqual({ role: "user", content: task });
      expect(calls(last).slice(-10)).toEqual(
        Array.from({ length: 10 }, (_, step) => `read-${step + 34}`),
      );
      expect(firstCall(last.find((message) => firstCall(message) !== undefined))).not.toBe(
        "read-0",
      );
      expect(resultOf(last, "read-43")?.content).toContain("y".repeat(4_000));
      expect(stage).toBe("leave-out");
      // The summary is the session's, kept for the next run; the saved run keeps every step.
      expect(Option.map(summary, ({ text }) => text)).toEqual(
        Option.some(`- 요약 ${asked.length - 1}`),
      );
      expect(resultOf(saved, "read-0")?.content).toContain("y".repeat(4_000));
    }),
  );

  it.effect("what a failed summary leaves out is behind a note, and summarized next time", () =>
    Effect.gen(function* () {
      const { asked, last } = yield* run(
        "retried",
        true,
        (attempt) => (attempt === 0 ? Option.none() : Option.some("- 요약")),
        leaveOutAt,
      );
      expect(asked.length).toBeGreaterThan(1);
      // The second summary reads again from where the first could not be written.
      expect(asked[1]?.previous).toEqual(Option.none());
      expect(asked[1]?.messages[0]).toEqual({ role: "user", content: task });
      expect(last[0]?.content).toContain("- 요약");
    }),
  );

  it.effect("summaries that keep failing are not asked for again in the run", () =>
    Effect.gen(function* () {
      const { asked, last, summary } = yield* run("failed", true, () => Option.none(), leaveOutAt);
      expect(asked).toHaveLength(summaryFailureLimit);
      expect(summary).toEqual(Option.none());
      // A note stands in for what is left out: how many messages, and where to reread outputs.
      const note = last.find((message) =>
        messageText(message).includes("left out to save context"),
      );
      expect(messageText(note!)).toContain("read_file: read_evidence read-");
      expect(last).toContainEqual({ role: "user", content: task });
      expect(resultOf(last, "read-43")?.content).toContain("y".repeat(4_000));
    }),
  );

  it.effect("a run whose requests stay under leaveOutAt asks for no summary", () =>
    Effect.gen(function* () {
      const { asked, summary } = yield* run("short", true, () => Option.some("- 요약"), 80_000);
      expect(asked).toEqual([]);
      expect(summary).toEqual(Option.none());
    }),
  );

  it.effect("steps whose outputs cannot be read again are not left out", () =>
    Effect.gen(function* () {
      const { asked, last } = yield* run(
        "unrecorded",
        false,
        () => Option.some("- 요약"),
        leaveOutAt,
      );
      expect(asked).toEqual([]);
      expect(firstCall(last[1])).toBe("read-0");
    }),
  );
});
