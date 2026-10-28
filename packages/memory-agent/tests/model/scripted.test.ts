import { it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { describe, expect } from "vite-plus/test";
import { toPrompt } from "../../src/model/prompt.ts";
import { scriptedModel } from "../../src/testing/scripted-model.ts";

/**
 * The scripted model streams what a provider would for each scripted turn and records the steps it
 * was asked for (docs/effect-ai-migration.md step 2).
 */

const prompt = toPrompt([{ role: "user", content: "go" }], ["Follow the rules."]);
const request = {
  prompt,
  toolkit: Toolkit.make(Tool.dynamic("read_file", { parameters: { type: "object" } })),
  disableToolCallResolution: true,
  toolCallValidation: "deferred",
} as const;

describe("scripted model", () => {
  it.effect("streams each turn in order and records the steps", () =>
    Effect.gen(function* () {
      const { model, invocations } = yield* scriptedModel([
        {
          text: "reading",
          toolCalls: [
            { id: "c-1", name: "read_file", arguments: '{"path":"a"}' },
            { id: "c-2", name: "read_file", arguments: '{"path":' },
          ],
        },
        { text: "done", usage: { inputTokens: { total: 3 }, outputTokens: { total: 1 } } },
      ]);
      const first = yield* Stream.runCollect(model.streamText(request));
      const second = yield* Stream.runCollect(model.streamText(request));
      const third = yield* Effect.flip(Stream.runCollect(model.streamText(request)));

      expect(first.filter((part) => part.type === "tool-call")).toMatchObject([
        { id: "c-1", name: "read_file", params: { path: "a" } },
        { id: "c-2", name: "read_file", params: '{"path":' },
      ]);
      expect(first.at(-1)).toMatchObject({ type: "finish", reason: "tool-calls" });
      expect(
        second.filter((part) => part.type === "text-delta" || part.type === "finish"),
      ).toMatchObject([
        { type: "text-delta", delta: "done" },
        { type: "finish", reason: "stop", usage: { inputTokens: { total: 3 } } },
      ]);
      expect(third.reason).toMatchObject({
        description: "scripted model ran out of turns at index 2",
      });
      expect(yield* invocations).toStrictEqual(
        [0, 1, 2].map((index) => ({
          index,
          run: { threadId: "scripted-thread", runId: "scripted-run" },
          system: ["Follow the rules."],
          history: [{ role: "user", content: "go" }],
          toolNames: ["read_file"],
        })),
      );
    }),
  );

  it.effect("fails after the text of a turn scripted to fail", () =>
    Effect.gen(function* () {
      const { model } = yield* scriptedModel([{ text: "half", failAfterText: "boom" }]);
      const received: Array<string> = [];
      const error = yield* Effect.flip(
        Stream.runForEach(model.streamText(request), (part) =>
          Effect.sync(() => received.push(part.type)),
        ),
      );
      expect(received).toStrictEqual(["response-metadata", "text-start", "text-delta", "text-end"]);
      expect(error.reason).toMatchObject({ description: "boom" });
    }),
  );
});
