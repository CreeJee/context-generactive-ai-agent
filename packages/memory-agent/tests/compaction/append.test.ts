import { Duration, Effect, Layer, Option, Schema } from "effect";
import { expect } from "vite-plus/test";
import {
  compactionHook,
  estimateConversation,
  LastRequests,
  lookupSources,
  nextRequestHistory,
  RequestBasis,
  type CompactionMessage,
  type SentRequest,
} from "../../src/agent/compaction.ts";
import { StoredMessage } from "../../src/chat-store/schema.ts";
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

const readCall = (id: string): ScriptedTurn => ({
  toolCalls: [{ id, name: "read_file", arguments: `{"path":"${id}.ts"}` }],
});

/** Every output can be read again by its call id, so compaction may clear any of them. */
const sources = lookupSources({ toolResultId: (id) => id, nodeText: () => null });

const sameMessage = Schema.toEquivalence(StoredMessage);

/** Whether `next` sends `previous` again first, so the provider reads it from its cache. */
const startsWith = (next: ReadonlyArray<StoredMessage>, previous: ReadonlyArray<StoredMessage>) =>
  previous.every((message, index) => {
    const other = next[index];
    return other !== undefined && sameMessage(message, other);
  });

/** One run of `turns` after `conversation`; what each of its requests sent. */
const run = Effect.fnUntraced(function* (options: {
  readonly name: string;
  readonly sessionId: string;
  readonly conversation: ReadonlyArray<StoredMessage>;
  readonly turns: readonly [ScriptedTurn, ...Array<ScriptedTurn>];
  readonly leaveOutAt: number;
  readonly lastRequests: LastRequests["Service"];
  readonly promptCacheFor: Duration.Duration;
}) {
  const compacting = yield* compactionHook({
    sources,
    budget: { compactAt: 0, leaveOutAt: options.leaveOutAt, inputCeiling: noLimit },
    restore: () => Effect.succeed(null),
    lastRequests: options.lastRequests,
    promptCacheFor: options.promptCacheFor,
  });
  const { invocations } = yield* scriptedRun({
    turns: options.turns,
    runId: `${options.sessionId}:${options.name}`,
    threadId: options.sessionId,
    conversation: options.conversation,
    tools: [readFile],
    hooks: [compacting.hook],
  });
  return (yield* invocations).map((invocation) => invocation.history);
});

/** A store of its own, so no other test's requests are appended to. */
const freshLastRequests = Effect.gen(function* () {
  const services = yield* Layer.build(LastRequests.layer);
  return yield* Effect.provideContext(LastRequests, services);
});

/**
 * Three runs of a session that each read a file and answer, with requests kept for `cachedFor`:
 * the second run's last request, and the third run's first.
 */
const threeRuns = Effect.fnUntraced(function* (cachedFor: Duration.Duration) {
  const { project } = yield* TestEnv;
  const session = yield* (yield* Sessions).create(project.id);
  const store = yield* RunStore;
  const lastRequests = yield* freshLastRequests;
  const turn = Effect.fnUntraced(function* (index: number) {
    const saved = yield* store.thread(session.id);
    return yield* run({
      name: `turn-${index}`,
      sessionId: session.id,
      conversation: [...saved, { role: "user", content: `질문 ${index}` }],
      turns: [readCall(`read-${index}`), { text: `답 ${index}` }],
      leaveOutAt: noLimit,
      lastRequests,
      promptCacheFor: cachedFor,
    });
  });
  yield* turn(1);
  const second = yield* turn(2);
  const third = yield* turn(3);
  return { second: second.at(-1) ?? [], third: third[0] ?? [] };
});

/** The content `request` sends for the call `id`. */
const resultOf = (request: ReadonlyArray<StoredMessage>, id: string) =>
  request.find((message) => message.role === "tool" && message.toolCallId === id)?.content;

/** Twenty steps that each read a file, then the answer. */
const longRun: readonly [ScriptedTurn, ...Array<ScriptedTurn>] = [
  readCall("read-0"),
  ...Array.from({ length: 19 }, (_, step) => readCall(`read-${step + 1}`)),
  { text: "다 읽었어요." },
];

testAgent()("requests append to the one before", (it) => {
  it.effect("a run compacts again only when its requests would pass leaveOutAt", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      const session = yield* (yield* Sessions).create(project.id);
      const leaveOutAt = 12_000;
      const sent = yield* run({
        name: "long",
        sessionId: session.id,
        conversation: [{ role: "user", content: "파일들을 읽어 줘" }],
        turns: longRun,
        leaveOutAt,
        lastRequests: yield* freshLastRequests,
        promptCacheFor: Duration.hours(1),
      });
      const rewritten = sent.filter(
        (request, index) => index > 0 && !startsWith(request, sent[index - 1] ?? []),
      );
      // Twenty steps of about 1,000 tokens pass 12,000 tokens twice, not on every later step.
      expect(rewritten.length).toBeGreaterThan(0);
      expect(rewritten.length).toBeLessThanOrEqual(2);
      expect(sent.every((request) => estimateConversation(request) <= leaveOutAt)).toBe(true);
    }),
  );

  it.effect("a new run's first request appends to the last one, answered outputs and all", () =>
    Effect.gen(function* () {
      const { second, third } = yield* threeRuns(Duration.hours(1));
      expect(startsWith(third, second)).toBe(true);
      // Compaction would clear the first run's output once a later run answered; appending keeps it.
      expect(resultOf(third, "read-1")).toContain("y".repeat(4_000));
    }),
  );

  it.effect("a run after the provider likely let the last request go is compacted again", () =>
    Effect.gen(function* () {
      const { second, third } = yield* threeRuns(Duration.zero);
      expect(startsWith(third, second)).toBe(false);
      expect(resultOf(third, "read-1")).not.toContain("y".repeat(4_000));
    }),
  );

  it.effect("leads already sent are not sent again before a message that joins the run", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      const session = yield* (yield* Sessions).create(project.id);
      const metadata = (yield* RunStore).chatMetadata;
      const leads: CompactionMessage = { role: "assistant", content: "[Retrieval appendix] lead" };
      const withLeads = { ...sources, retrievalAppendix: () => Effect.succeed(leads) };
      const asked: StoredMessage = { role: "user", content: "질문" };
      // A request that left content out, with leads before its turn.
      const previous: SentRequest = {
        from: [asked],
        messages: [leads, asked],
        stage: "leave-out",
        manual: { clearedThrough: 0, summarizedTurns: 0 },
      };
      const step: ReadonlyArray<StoredMessage> = [
        {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "read-0",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"read-0.ts"}' },
            },
          ],
        },
        { role: "tool", toolCallId: "read-0", content: "y".repeat(4_000) },
      ];
      const joined: StoredMessage = { role: "user", content: "그리고 이것도" };
      const next = yield* nextRequestHistory({
        metadata,
        threadId: session.id,
        messages: [asked, ...step, joined],
        restored: null,
        sources: withLeads,
        budget: { compactAt: 0, leaveOutAt: noLimit, inputCeiling: noLimit },
        previous: Option.some(previous),
      });
      expect(next.basis).toEqual(RequestBasis.Appended());
      expect(next.messages.filter((message) => message === leads)).toHaveLength(1);
      expect(next.messages.at(-1)).toEqual(joined);
    }),
  );

  it.effect("a request compacted again past leaveOutAt comes down to half, summaries or not", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      const session = yield* (yield* Sessions).create(project.id);
      const asked: StoredMessage = { role: "user", content: "파일들을 읽어 줘" };
      const steps = Array.from({ length: 14 }, (_, index): ReadonlyArray<StoredMessage> => [
        {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: `read-${index}`,
              type: "function",
              function: { name: "read_file", arguments: `{"path":"read-${index}.ts"}` },
            },
          ],
        },
        { role: "tool", toolCallId: `read-${index}`, content: "y".repeat(4_000) },
      ]);
      const sentBefore = [asked, ...steps.slice(0, 10).flat()];
      const leaveOutAt = 12_000;
      const next = yield* nextRequestHistory({
        metadata: (yield* RunStore).chatMetadata,
        threadId: session.id,
        messages: [asked, ...steps.flat()],
        restored: null,
        sources,
        budget: { compactAt: 0, leaveOutAt, inputCeiling: noLimit },
        // The summary takes off four steps: the ten left fit under leaveOutAt, not under half.
        steps: [{ from: "read-0", through: "read-3", text: "read-0부터 read-3까지 읽었다." }],
        previous: Option.some({
          from: sentBefore,
          messages: sentBefore,
          stage: "none",
          manual: { clearedThrough: 0, summarizedTurns: 0 },
        }),
      });
      expect(next.basis).toEqual(RequestBasis.Rebuilt({ reason: "over-budget" }));
      // Short of half, the next few steps would pass leaveOutAt and write it to the cache again.
      expect(next.estimatedTokens).toBeLessThanOrEqual(leaveOutAt / 2);
    }),
  );
});
