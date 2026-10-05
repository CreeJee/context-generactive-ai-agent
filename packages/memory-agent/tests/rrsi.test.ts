import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCodeProposal, editableCode } from "../src/rrsi/code-candidate.ts";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vite-plus/test";
import { migrateDatabase } from "../src/db/database.ts";
import { baselineProfile, type ExperimentRecord } from "../src/rrsi/contracts.ts";
import { makeHarnessStore } from "../src/rrsi/store.ts";
import { editBudget, noiseBand, selectCandidate } from "../src/rrsi/selection.ts";
import { reportedTokens } from "../src/rrsi/sandbox.ts";

const connections: DatabaseSync[] = [];
afterEach(() => {
  for (const db of connections.splice(0)) db.close();
});
const setup = () => {
  const sqlite = new DatabaseSync(":memory:");
  connections.push(sqlite);
  migrateDatabase(sqlite);
  const owner = {
    sqlite,
    atomic: <A>(work: () => A) => {
      sqlite.exec("BEGIN");
      try {
        const result = work();
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { owner, store: makeHarnessStore(owner) };
};
const base = { score: 0.7, coding: 0.7, memory: 0.7, tokens: 1000 };
const policy = { delta: 0.02, bestScore: 0.7, beta0: 0.1, beta1: 2 };

test("noise-band gains require lower cost; genuine gains must justify cost growth", () => {
  expect(selectCandidate(base, { ...base, score: 0.71 }, policy)).toEqual({
    kind: "rejected",
    reason: "within_noise_without_savings",
  });
  expect(selectCandidate(base, { ...base, tokens: 900 }, policy)).toEqual({ kind: "accepted" });
  expect(
    selectCandidate(base, { ...base, score: 0.8, coding: 0.8, memory: 0.8, tokens: 1200 }, policy),
  ).toEqual({ kind: "accepted" });
  expect(selectCandidate(base, { ...base, score: 0.8, tokens: 1500 }, policy)).toEqual({
    kind: "rejected",
    reason: "cost_growth",
  });
});
test("best-ever floor and domain guards prevent accumulated or hidden regressions", () => {
  expect(selectCandidate(base, { ...base, score: 0.67, tokens: 500 }, policy)).toEqual({
    kind: "rejected",
    reason: "below_best_floor",
  });
  expect(selectCandidate(base, { ...base, score: 0.8, coding: 0.5, memory: 1 }, policy)).toEqual({
    kind: "rejected",
    reason: "domain_regression",
  });
  expect(selectCandidate(base, { ...base, tokens: null }, policy)).toEqual({
    kind: "rejected",
    reason: "usage_unknown",
  });
});
test("edit budget anneals and noise calibration requires repeated measurements", () => {
  expect(editBudget(0, 2)).toBe(3);
  expect(editBudget(1, 2)).toBe(1);
  expect(noiseBand([0.5, 0.6, 0.55])).toBeCloseTo(0.1);
  expect(() => noiseBand([0.5])).toThrow();
});
test("provider cache counts are not added to included input and absent usage stays unknown", () => {
  expect(
    reportedTokens(
      JSON.stringify({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 70 },
        },
      }),
    ),
  ).toBe(120);
  expect(reportedTokens("{}")).toBeNull();
});
test("Goal pins survive profile adoption, rollback and reopening", () => {
  const { owner, store } = setup();
  const pinned = store.forGoal("goal-a");
  const improved = store.adopt(
    { ...baselineProfile, rolePrompt: "Read evidence before concluding." },
    pinned.id,
  );
  expect(store.forGoal("goal-a").id).toBe(pinned.id);
  expect(store.forGoal("goal-b").id).toBe(improved.id);
  store.restore("baseline");
  expect(store.forGoal("goal-c").id).toBe("baseline");
  const reopened = makeHarnessStore(owner);
  expect(reopened.forGoal("goal-b").id).toBe(improved.id);
  expect(reopened.current().id).toBe("baseline");
  expect(() => reopened.adopt(baselineProfile, improved.id)).toThrow("frontier_changed");
  expect(() => owner.sqlite.prepare("UPDATE rrsi_versions SET payload='{}'").run()).toThrow(
    "immutable",
  );
});
test("restarting an owner records uncertain experiments as cancelled", () => {
  const { owner, store } = setup();
  const record: ExperimentRecord = {
    id: "experiment",
    status: "running",
    startedAt: 1,
    finishedAt: null,
    model: "local",
    endpoint: "http://localhost",
    baseVersion: "baseline",
    tokens: 123,
    reason: "",
    candidates: [],
  };
  store.saveExperiment(record);
  store.saveExperiment({ ...record, progress: { phase: "baseline", completed: 7, total: 36 } });
  expect(store.experiments()[0].progress).toEqual({ phase: "baseline", completed: 7, total: 36 });
  expect(() => store.saveExperiment({ ...record, id: "duplicate" })).toThrow();
  const reopened = makeHarnessStore(owner);
  expect(reopened.experiments()[0]).toMatchObject({
    status: "cancelled",
    reason: "owner_restarted",
    tokens: 123,
    progress: { phase: "baseline", completed: 7, total: 36 },
  });
  expect(reopened.current().id).toBe("baseline");
});

test("code proposals reject protected paths and ambiguous anchors without partial writes", () => {
  const directory = mkdtempSync(join(tmpdir(), "rrsi-code-test-"));
  try {
    const path = editableCode[0];
    const file = join(directory, path);
    mkdirSync(join(directory, "packages/memory-agent/src/agent"), { recursive: true });
    writeFileSync(file, "const first = 1;\nconst second = 2;\n");
    const edits = [{ component: "prompt" as const, hypothesis: "Shorten redundant instructions." }];
    expect(() =>
      applyCodeProposal(directory, {
        edits,
        files: [
          { path, before: "const first = 1;", after: "const first = 3;" },
          { path: "packages/memory-agent/eval/rrsi-worker.ts", before: "check", after: "skip" },
        ],
      }),
    ).toThrow("protected_code_path");
    expect(readFileSync(file, "utf8")).toContain("const first = 1;");
    expect(() =>
      applyCodeProposal(directory, { edits, files: [{ path, before: "const", after: "let" }] }),
    ).toThrow("code_anchor_ambiguous");
    applyCodeProposal(directory, {
      edits,
      files: [{ path, before: "const first = 1;", after: "const first = 3;" }],
    });
    expect(readFileSync(file, "utf8")).toContain("const first = 3;");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy persisted token budgets no longer constrain experiment settings", () => {
  const { owner, store } = setup();
  owner.sqlite
    .prepare("UPDATE rrsi_state SET settings=? WHERE id=1")
    .run(JSON.stringify({ enabled: true, maxTokens: 1000, maxMinutes: 30 }));
  expect(store.settings()).toEqual({ enabled: true, maxMinutes: 30 });
  expect(makeHarnessStore(owner).settings()).toEqual({ enabled: true, maxMinutes: 30 });
});
