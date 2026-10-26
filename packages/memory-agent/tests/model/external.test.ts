import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { it } from "@effect/vitest";
import { Cause, Deferred, Effect, Fiber, Option, Stream } from "effect";
import { Prompt } from "effect/ai";
import { describe, expect } from "vite-plus/test";
import { ExternalPromptOutcome } from "../../src/external-agents/agents.ts";
import {
  ExternalAgentTurnFailed,
  externalFailure,
  externalModel,
  type ExternalModelOptions,
} from "../../src/model/external.ts";

/**
 * The external agent model's contract (docs/effect-ai-migration.md step 2): what a step sends the
 * agent, what it streams for the agent's updates, and which failures its `AiError` carries.
 */

const prompt = Prompt.make([
  { role: "system", content: "Follow the rules." },
  { role: "user", content: "earlier words" },
  { role: "assistant", content: "earlier answer" },
  {
    role: "user",
    content: [
      { type: "text", text: "look " },
      { type: "file", mediaType: "image/png", data: "AAAA" },
      { type: "text", text: "here" },
    ],
  },
]);

const answered = { stopReason: "end_turn", answer: "", toolCalls: [] } as const;

const textChunk = (text: string): SessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});

/** A turn that sends `updates` and ends with `outcome`, recording the text it was sent. */
const turnOf =
  (
    updates: ReadonlyArray<SessionUpdate>,
    outcome: ExternalPromptOutcome,
    sent: Array<string> = [],
  ): ExternalModelOptions["turn"] =>
  (text, onUpdate) =>
    Effect.sync(() => {
      sent.push(text);
      for (const update of updates) onUpdate(update);
      return outcome;
    });

const partsOf = (options: ExternalModelOptions) =>
  Effect.flatMap(externalModel(options), (model) =>
    Stream.runCollect(
      model.streamText({ prompt, disableToolCallResolution: true, toolCallValidation: "deferred" }),
    ),
  );

const options = (turn: ExternalModelOptions["turn"]): ExternalModelOptions => ({
  agent: "fixture-agent",
  turn,
  preamble: (text) => Effect.succeed(`Leads for ${text}.\n`),
});

describe("external agent model", () => {
  it.effect("sends the last user text after the preamble and lists the reported calls", () =>
    Effect.gen(function* () {
      const sent: Array<string> = [];
      const parts = yield* partsOf(
        options(
          turnOf(
            [
              textChunk("Hello"),
              { sessionUpdate: "tool_call", toolCallId: "c-1", title: "Read a.ts" },
              { sessionUpdate: "tool_call", toolCallId: "c-2", title: "Run tests" },
              textChunk(" world"),
              { sessionUpdate: "tool_call_update", toolCallId: "c-1", status: "completed" },
              { sessionUpdate: "tool_call_update", toolCallId: "c-2", title: "Run all tests" },
            ],
            ExternalPromptOutcome.completed(answered),
            sent,
          ),
        ),
      );
      expect(sent).toStrictEqual(["Leads for look here.\nlook here"]);
      expect(parts).toMatchObject([
        { type: "response-metadata", modelId: "fixture-agent" },
        { type: "text-start", id: "text-0" },
        { type: "text-delta", delta: "Hello" },
        { type: "text-delta", delta: " world" },
        {
          type: "text-delta",
          delta:
            "\n\n외부 에이전트가 알린 도구 호출:\n- Read a.ts (completed)\n- Run all tests (pending)",
        },
        { type: "text-end", id: "text-0" },
        { type: "finish", reason: "stop" },
      ]);
    }),
  );

  it.effect("fails with the turn failure when the agent did not answer", () =>
    Effect.gen(function* () {
      for (const [outcome, failure] of [
        [
          ExternalPromptOutcome.failed({
            failure: { code: "agent_error", detail: "agent text" },
            answer: "partial",
            toolCalls: [],
          }),
          { code: "agent_error", detail: "agent text" },
        ],
        [
          ExternalPromptOutcome.unavailable({ failure: { code: "not_trusted", detail: null } }),
          { code: "not_trusted", detail: null },
        ],
        [
          ExternalPromptOutcome.disconnected({ answer: "", toolCalls: [] }),
          { code: "disconnected", detail: null },
        ],
      ] as const) {
        const error = yield* Effect.flip(partsOf(options(turnOf([], outcome))));
        expect(Option.getOrUndefined(externalFailure(error))).toStrictEqual(
          ExternalAgentTurnFailed.make(failure),
        );
        expect(error.reason).toMatchObject({ description: failure.detail ?? failure.code });
      }
    }),
  );

  it.effect("fails with the rejection's message when the turn rejected", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        partsOf(
          options(() => Effect.fail(new Cause.UnknownError(new Error("connection refused")))),
        ),
      );
      expect(Option.isNone(externalFailure(error))).toBe(true);
      expect(error.reason).toMatchObject({
        _tag: "UnknownError",
        description: "connection refused",
      });
    }),
  );

  it.effect("cancels the turn when the step is interrupted", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        partsOf(
          options((_text, onUpdate) =>
            Effect.sync(() => onUpdate(textChunk("partial"))).pipe(
              Effect.andThen(Deferred.succeed(entered, undefined)),
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
            ),
          ),
        ),
      );
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      yield* Deferred.await(cancelled);
    }),
  );
});
