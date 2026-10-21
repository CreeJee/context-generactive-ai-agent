import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import {
  AgentRunAttempt,
  RunEvent,
  type AttemptStatus,
  canTransitionAttempt,
  isActiveAttemptStatus,
  isTerminalAttemptStatus,
  isUserVisibleTrace,
  resumeCreatesNewAttempt,
} from "../src/work-trace/contracts.ts";

describe("Work Trace domain contracts", () => {
  test("separates active physical attempts from terminal history", () => {
    const active: AttemptStatus[] = ["queued", "running", "waiting", "blocked"];
    const terminal: AttemptStatus[] = ["interrupted", "completed", "failed", "cancelled"];
    expect(active.every(isActiveAttemptStatus)).toBe(true);
    expect(terminal.every(isTerminalAttemptStatus)).toBe(true);
    expect(isActiveAttemptStatus("interrupted")).toBe(false);
  });

  test("never moves a terminal attempt back to running", () => {
    expect(canTransitionAttempt("queued", "running")).toBe(true);
    expect(canTransitionAttempt("running", "waiting")).toBe(true);
    expect(canTransitionAttempt("waiting", "running")).toBe(true);
    expect(canTransitionAttempt("running", "completed")).toBe(true);
    expect(canTransitionAttempt("interrupted", "running")).toBe(false);
    expect(canTransitionAttempt("failed", "running")).toBe(false);
  });

  test("distinguishes steer from a resume that creates a new attempt", () => {
    expect(resumeCreatesNewAttempt("steer")).toBe(false);
    expect(resumeCreatesNewAttempt("continue")).toBe(false);
    expect(resumeCreatesNewAttempt("resume")).toBe(true);
  });

  it.effect("represents resume lineage without changing the previous attempt", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(AgentRunAttempt);
      const previous = yield* decode({
        id: "attempt-1",
        taskId: "task-1",
        invocationId: "invocation-1",
        attemptNumber: 1,
        chatRunId: "run-1",
        threadId: "subagent-agent-1",
        status: "interrupted",
        resumedFromAttemptId: null,
        supersededByAttemptId: "attempt-2",
        startedAt: 1,
        finishedAt: 2,
      });
      const resumed = yield* decode({
        ...previous,
        id: "attempt-2",
        invocationId: "invocation-2",
        attemptNumber: 2,
        chatRunId: "run-2",
        status: "running",
        resumedFromAttemptId: "attempt-1",
        supersededByAttemptId: null,
        startedAt: 3,
        finishedAt: null,
      });

      expect(previous.status).toBe("interrupted");
      expect(resumed.resumedFromAttemptId).toBe(previous.id);
      expect(resumed.chatRunId).not.toBe(previous.chatRunId);
    }),
  );

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
