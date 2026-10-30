import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { StoredMessage } from "../chat-store/schema.ts";
import { followupTurnHook } from "./followup-turn.ts";

const scope = { threadId: "thread", runId: "run", emit: () => Effect.void };
const answer: StoredMessage = { role: "assistant", id: "answer", content: "Started the tests." };
const call: StoredMessage = {
  role: "assistant",
  id: "call",
  toolCalls: [
    { id: "c1", type: "function", function: { name: "get_background_result", arguments: "{}" } },
  ],
};
const result: StoredMessage = { role: "tool", toolCallId: "c1", content: "passed" };
const turn: StoredMessage = {
  role: "user",
  content: [{ type: "text", content: "<system-reminder>\nA task finished.\n</system-reminder>" }],
};

describe("follow-up turn", () => {
  it.effect("follows the message the run started from on every step, or ends the history", () =>
    Effect.gen(function* () {
      const { request } = followupTurnHook(["A task finished."], answer);
      const sent = (history: ReadonlyArray<StoredMessage>) =>
        Effect.map(request(scope, { system: [], history }), (step) => step.history);

      expect(yield* sent([answer])).toEqual([answer, turn]);
      expect(yield* sent([answer, call, result])).toEqual([answer, turn, call, result]);
      expect(yield* sent([call, result])).toEqual([call, result, turn]);
    }),
  );
});
