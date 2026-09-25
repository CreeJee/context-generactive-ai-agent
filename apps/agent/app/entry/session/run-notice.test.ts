import { serverRestartedCode, type SessionRunState } from "memory-agent/definitions";
import { describe, expect, test } from "vite-plus/test";
import { allowedWorkflowActions } from "./workflow-test-fixtures";
import { noticeOf } from "./run-notice";

const record = (
  lastRun: SessionRunState["lastRun"],
  running: SessionRunState["running"] = null,
): SessionRunState => ({
  actions: allowedWorkflowActions,
  running,
  lastRun,
  lease: { state: "mine" },
  context: {
    usedTokens: null,
    cachedTokens: null,
    cacheRatio: null,
    compactionStage: null,
    windowTokens: 258_400,
    windowKnown: false,
    compactAtTokens: 64_600,
  },
  workflow: { phase: "chat", goal: null, plan: null, ledger: [] },
});
const ended = (status: "completed" | "interrupted" | "failed" | "aborted", code?: string) =>
  record({
    runId: "run-1",
    status,
    error: code || status === "failed" ? { message: "boom", code } : null,
  });
const page = { waitingForApproval: false, answered: true };

describe("run notices", () => {
  test("a finished run that looks finished says nothing", () => {
    expect(noticeOf(null, page)).toBeNull();
    expect(noticeOf(record(null), page)).toBeNull();
    expect(noticeOf(ended("completed"), page)).toBeNull();
    expect(noticeOf(ended("interrupted"), { ...page, waitingForApproval: true })).toBeNull();
  });

  test("tells apart a run still going elsewhere, one that stopped, and one that never answered", () => {
    expect(noticeOf(record(null, { runId: "run-2" }), page)).toEqual({ kind: "detached" });
    expect(noticeOf(ended("interrupted"), page)).toEqual({ kind: "stopped" });
    expect(noticeOf(ended("completed"), { ...page, answered: false })).toEqual({
      kind: "no-answer",
    });
  });

  test("reports cancels, failures and restarts, a restart whatever status it was left with", () => {
    expect(noticeOf(ended("aborted"), page)).toEqual({ kind: "cancelled" });
    expect(noticeOf(ended("failed"), page)).toEqual({ kind: "failed", message: "boom" });
    expect(noticeOf(ended("failed", serverRestartedCode), page)).toEqual({ kind: "restarted" });
    expect(noticeOf(ended("completed", serverRestartedCode), page)).toEqual({ kind: "restarted" });
  });
});
