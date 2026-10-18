import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { applyCodeProposal, editableCode } from "../src/rrsi/code-candidate.ts";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vite-plus/test";
import { connectionContext, migrateDatabase } from "../src/db/database.ts";
import { baselineProfile, type ExperimentRecord } from "../src/rrsi/contracts.ts";
import { makeHarnessStore } from "../src/rrsi/store.ts";
import { editBudget, noiseBand, selectCandidate } from "../src/rrsi/selection.ts";
import { reportedTokens } from "../src/rrsi/sandbox.ts";

const connections: DatabaseSync[] = [];
afterEach(() => {
  for (const db of connections.splice(0)) db.close();
});
/** A store over `sqlite`, as a (re)started owner constructs it. */
const open = (sqlite: DatabaseSync) =>
  Effect.flatMap(connectionContext(sqlite), (context) =>
    Effect.provideContext(makeHarnessStore, context),
  );
const setup = Effect.gen(function* () {
  const sqlite = new DatabaseSync(":memory:");
  connections.push(sqlite);
  migrateDatabase(sqlite);
  return { sqlite, store: yield* open(sqlite) };
});
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
it.effect("Goal pins survive profile adoption, rollback and reopening", () =>
  Effect.gen(function* () {
    const { sqlite, store } = yield* setup;
    const pinned = yield* store.forGoal("goal-a");
    const improved = yield* store.adopt(
      { ...baselineProfile, rolePrompt: "Read evidence before concluding." },
      pinned.id,
    );
    expect((yield* store.forGoal("goal-a")).id).toBe(pinned.id);
    expect((yield* store.forGoal("goal-b")).id).toBe(improved.id);
    yield* store.restore("baseline");
    expect((yield* store.forGoal("goal-c")).id).toBe("baseline");
    const reopened = yield* open(sqlite);
    expect((yield* reopened.forGoal("goal-b")).id).toBe(improved.id);
    expect((yield* reopened.current).id).toBe("baseline");
    expect(yield* Effect.flip(reopened.adopt(baselineProfile, improved.id))).toMatchObject({
      reason: "frontier_changed",
    });
    expect(() => sqlite.prepare("UPDATE rrsi_versions SET payload='{}'").run()).toThrow(
      "immutable",
    );
  }),
);
it.effect("restarting an owner records uncertain experiments as cancelled", () =>
  Effect.gen(function* () {
    const { sqlite, store } = yield* setup;
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
    yield* store.saveExperiment(record);
    yield* store.saveExperiment({
      ...record,
      progress: { phase: "baseline", completed: 7, total: 36 },
    });
    expect((yield* store.experiments)[0]?.progress).toEqual({
      phase: "baseline",
      completed: 7,
      total: 36,
    });
    expect(yield* Effect.flip(store.saveExperiment({ ...record, id: "duplicate" }))).toMatchObject({
      reason: "storage",
    });
    const reopened = yield* open(sqlite);
    expect((yield* reopened.experiments)[0]).toMatchObject({
      status: "cancelled",
      reason: "owner_restarted",
      tokens: 123,
      progress: { phase: "baseline", completed: 7, total: 36 },
    });
    expect((yield* reopened.current).id).toBe("baseline");
  }),
);

it.live("code proposals reject protected paths and ambiguous anchors without partial writes", () =>
  Effect.gen(function* () {
    const context = yield* Layer.build(Layer.merge(NodeFileSystem.layer, NodePath.layer));
    const { fs, paths } = yield* Effect.gen(function* () {
      return { fs: yield* FileSystem.FileSystem, paths: yield* Path.Path };
    }).pipe(Effect.provideContext(context));
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "rrsi-code-test-" });
    const path = editableCode[0];
    const file = paths.join(directory, path);
    yield* fs.makeDirectory(paths.join(directory, "packages/memory-agent/src/agent"), {
      recursive: true,
    });
    yield* fs.writeFileString(file, "const first = 1;\nconst second = 2;\n");
    const edits = [{ component: "prompt" as const, hypothesis: "Shorten redundant instructions." }];
    const apply = (proposal: Parameters<typeof applyCodeProposal>[1]) =>
      applyCodeProposal(directory, proposal).pipe(Effect.provideContext(context));
    const protectedPath = yield* Effect.flip(
      apply({
        edits,
        files: [
          { path, before: "const first = 1;", after: "const first = 3;" },
          { path: "packages/memory-agent/eval/rrsi-worker.ts", before: "check", after: "skip" },
        ],
      }),
    );
    expect(protectedPath).toMatchObject({ cause: { message: "protected_code_path" } });
    expect(yield* fs.readFileString(file)).toContain("const first = 1;");
    const ambiguous = yield* Effect.flip(
      apply({ edits, files: [{ path, before: "const", after: "let" }] }),
    );
    expect(ambiguous).toMatchObject({ cause: { message: "code_anchor_ambiguous" } });
    yield* apply({
      edits,
      files: [{ path, before: "const first = 1;", after: "const first = 3;" }],
    });
    expect(yield* fs.readFileString(file)).toContain("const first = 3;");
  }),
);

it.effect("legacy persisted token budgets no longer constrain experiment settings", () =>
  Effect.gen(function* () {
    const { sqlite, store } = yield* setup;
    sqlite
      .prepare("UPDATE rrsi_state SET settings=? WHERE id=1")
      .run('{"enabled":true,"maxTokens":1000,"maxMinutes":30}');
    expect(yield* store.settings).toEqual({ enabled: true, maxMinutes: 30 });
    expect(yield* (yield* open(sqlite)).settings).toEqual({ enabled: true, maxMinutes: 30 });
  }),
);
