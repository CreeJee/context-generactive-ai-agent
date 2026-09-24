import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import type { SessionRunState } from "memory-agent/definitions";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { allowedWorkflowActions } from "./workflow-test-fixtures";
import { api, ApiError } from "./api";
import { SessionEventScopeContext } from "./events/context";
import { createInvalidationBatch } from "./events/invalidation";
import { appQueryKeys } from "./events/query-keys";
import { useRunState } from "./use-run-state";

const projectId = "project-1";
const sessionId = "session-1";
const queryKey = appQueryKeys.session.runState(projectId, sessionId);
const snapshot = (version: number): SessionRunState => ({
  actions: allowedWorkflowActions,
  running: { runId: "run-1" },
  lastRun: null,
  lease: { state: "mine" },
  context: {
    usedTokens: null,
    cachedTokens: null,
    cacheRatio: null,
    compactionStage: null,
    windowTokens: 258400,
    compactAtTokens: 64600,
  },
  workflow: {
    phase: "plan",
    goal: {
      version,
      statement: "Repair workflow",
      status: "active",
      outcomes: [],
      constraints: [],
      nonGoals: [],
      assumptions: [],
      openQuestions: [],
      evidence: [],
      updatedAt: "2026-09-24",
      verification: {
        status: "not_run",
        summary: "",
        evidence: [],
        recoveryPhase: null,
        updatedAt: null,
      },
    },
    plan: null,
    ledger: [],
  },
});

type Run = ReturnType<typeof useRunState>;

function Probe({ generating, onRun }: { generating: boolean; onRun?: (run: Run) => void }) {
  const run = useRunState(sessionId, "holder-1", generating, {
    waitingForApproval: false,
    answered: false,
  });
  onRun?.(run);
  return (
    <span>
      {run.workflow?.goal?.version}:{run.notice?.kind ?? "none"}
    </span>
  );
}

function render(client: QueryClient, generating: boolean, onRun?: (run: Run) => void) {
  return renderToString(
    <QueryClientProvider client={client}>
      <SessionEventScopeContext value={{ projectId, sessionId }}>
        <Probe generating={generating} onRun={onRun} />
      </SessionEventScopeContext>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("server mutation results", () => {
  function mounted() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKey, snapshot(1));
    const captured: Run[] = [];
    render(client, false, (run) => captured.push(run));
    const run = captured[0];
    if (!run) throw new Error("Missing hook result");
    return { client, run };
  }

  test.each(["phase", "control"] as const)(
    "%s changes refresh artifacts and decisions together, including refusals",
    async (kind) => {
      const { client, run } = mounted();
      const fetchState = vi.spyOn(api, "sessionRunState").mockResolvedValue(snapshot(1));
      const query = client.getQueryCache().find({ queryKey });
      if (!query) throw new Error("Missing query");
      const observer = new QueryObserver(client, { ...query.options, queryKey });
      const unsubscribe = observer.subscribe(() => {});
      try {
        await observer.refetch();
        const latest: SessionRunState = {
          ...snapshot(2),
          actions: {
            ...allowedWorkflowActions,
            phases: {
              ...allowedWorkflowActions.phases,
              execute: { allowed: false, reason: "plan_outdated" },
            },
          },
        };
        fetchState.mockResolvedValue(latest);
        const phase = vi.spyOn(api, "setWorkflowPhase").mockResolvedValue(snapshot(2).workflow);
        const control = vi.spyOn(api, "controlWorkflow").mockResolvedValue(snapshot(2).workflow);
        const mutate = () =>
          kind === "phase" ? run.setWorkflowPhase("plan") : run.controlWorkflow("pause");
        await mutate();
        expect(client.getQueryData(queryKey)).toEqual(latest);
        const refusal = new ApiError(409, "run_in_progress", null);
        phase.mockRejectedValue(refusal);
        control.mockRejectedValue(refusal);
        fetchState.mockResolvedValue(snapshot(3));
        await expect(mutate()).rejects.toBe(refusal);
        expect(client.getQueryData(queryKey)).toEqual(snapshot(3));
      } finally {
        unsubscribe();
        client.clear();
      }
    },
  );

  test("cancel is submitted without local streaming and only no_running_run means idle", async () => {
    const { client, run } = mounted();
    const cancel = vi
      .spyOn(api, "cancelRun")
      .mockResolvedValue({ runId: "child-parent", stopped: true, status: null });
    try {
      expect(await run.cancel()).toBe("requested");
      expect(cancel).toHaveBeenCalledWith(sessionId, "holder-1");
      cancel.mockRejectedValue(new ApiError(409, "session_in_use", null));
      expect(await run.cancel()).toBe("failed");
      cancel.mockRejectedValue(new ApiError(409, "no_running_run", null));
      expect(await run.cancel()).toBe("idle");
      cancel.mockRejectedValue(new Error("offline"));
      expect(await run.cancel()).toBe("failed");
    } finally {
      client.clear();
    }
  });
});

describe("durable workflow refresh", () => {
  test.each([true, false])(
    "run-state invalidation refreshes Goal while generating=%s",
    async (generating) => {
      vi.useFakeTimers();
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryData(queryKey, snapshot(1));
      const fetchState = vi.spyOn(api, "sessionRunState").mockResolvedValue(snapshot(1));
      render(client, generating);
      const query = client.getQueryCache().find({ queryKey });
      if (!query) throw new Error("useRunState did not register its query");
      // SSR registers the hook's real options; subscribe with them to exercise React Query's
      // active-query invalidation without requiring a browser DOM or mocking useQuery.
      const observer = new QueryObserver(client, { ...query.options, queryKey });
      const unsubscribe = observer.subscribe(() => {});
      const batch = createInvalidationBatch(
        (key) => {
          void client.invalidateQueries({ queryKey: key });
        },
        appQueryKeys.session.root(projectId, sessionId),
      );
      try {
        await vi.advanceTimersByTimeAsync(0);
        fetchState.mockClear();
        fetchState.mockResolvedValue(snapshot(2));
        batch.changed({ scope: "session", projectId, sessionId, topic: "run-state", revision: 1 });
        await vi.advanceTimersByTimeAsync(50);
        expect(fetchState).toHaveBeenCalledOnce();
        expect(fetchState).toHaveBeenCalledWith(sessionId, "holder-1");
        expect(client.getQueryData<SessionRunState>(queryKey)?.workflow.goal?.version).toBe(2);
        expect(client.getQueryData<SessionRunState>(queryKey)?.running).not.toBeNull();
        expect(render(client, generating)).toContain("2");
      } finally {
        batch.close();
        unsubscribe();
        client.clear();
      }
    },
  );

  test("streaming is not reported as detached, but an idle page still reports it", () => {
    const client = new QueryClient();
    try {
      client.setQueryData(queryKey, snapshot(2));
      expect(render(client, true)).toContain("none");
      expect(render(client, false)).toContain("detached");
    } finally {
      client.clear();
    }
  });
});
