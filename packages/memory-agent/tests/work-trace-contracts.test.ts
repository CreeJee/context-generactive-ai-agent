import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { RunEvent, canTransitionAttempt, isUserVisibleTrace } from "../src/work-trace/contracts.ts";

describe("Work Trace domain contracts", () => {
  test("never moves a terminal attempt back to running", () => {
    expect(canTransitionAttempt("queued", "running")).toBe(true);
    expect(canTransitionAttempt("running", "waiting")).toBe(true);
    expect(canTransitionAttempt("waiting", "running")).toBe(true);
    expect(canTransitionAttempt("running", "completed")).toBe(true);
    expect(canTransitionAttempt("interrupted", "running")).toBe(false);
    expect(canTransitionAttempt("failed", "running")).toBe(false);
  });

  it.effect("keeps internal reasoning and omitted sensitive events out of user projections", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(RunEvent);
      const base = {
        id: "event-1",
        originSessionId: "session-1",
        taskId: "task-1",
        invocationId: "invocation-1",
        attemptId: "attempt-1",
        sequence: 1,
        kind: "steered",
        summary: "Checking the repository",
        occurredAt: 1,
      } as const;
      expect(
        isUserVisibleTrace(yield* decode({ ...base, visibility: "public", redaction: "clear" })),
      ).toBe(true);
      expect(
        isUserVisibleTrace(
          yield* decode({ ...base, visibility: "summary", redaction: "redacted" }),
        ),
      ).toBe(true);
      expect(
        isUserVisibleTrace(yield* decode({ ...base, visibility: "internal", redaction: "clear" })),
      ).toBe(false);
      expect(
        isUserVisibleTrace(yield* decode({ ...base, visibility: "public", redaction: "omitted" })),
      ).toBe(false);
    }),
  );
});
