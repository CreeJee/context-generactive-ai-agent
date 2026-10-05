import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Context, Effect, Layer, Schema } from "effect";
import { Database } from "../db/database.ts";
import { OpenAICompatibleSettings } from "../providers/openai-compatible.ts";
import { GlobalConfig } from "../config/global-config.ts";
import { ProviderRegistry } from "../providers/registry.ts";
import { pinModelGateway, type ModelGateway } from "./model-gateway.ts";
import { HarnessStore } from "./store.ts";
import {
  Proposal,
  CodeProposal,
  type ExperimentRecord,
  type CandidateRecord,
  type HarnessProfile,
  type Measurement,
  type RrsiSettings,
} from "./contracts.ts";
import { editBudget, exploration, noiseBand, selectCandidate } from "./selection.ts";
import { codeContext, prepareCodeCandidate } from "./code-candidate.ts";
import { evaluateSandbox, reportedTokens } from "./sandbox.ts";
import { experimentFailure } from "./failure.ts";
import { activitySql } from "./activity.ts";

export class RrsiFailed extends Schema.TaggedError<RrsiFailed>()("RrsiFailed", {
  reason: Schema.String,
}) {}
type MutableCandidate = { -readonly [K in keyof CandidateRecord]: CandidateRecord[K] };
type MutableExperiment = {
  -readonly [K in keyof Omit<ExperimentRecord, "candidates">]: ExperimentRecord[K];
} & { candidates: MutableCandidate[] };
const run = promisify(execFile);
const Completion = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({ message: Schema.Struct({ content: Schema.NullOr(Schema.String) }) }),
  ),
});
const completionText = (raw: string) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Completion))(raw).choices[0]?.message.content ??
  "";
const Critique = Schema.Struct({ approved: Schema.Boolean });
const Activity = Schema.Struct({ busy: Schema.Number, latest: Schema.NullOr(Schema.Number) });
function activity(sqlite: DatabaseSync) {
  return Schema.decodeUnknownSync(Activity)(sqlite.prepare(activitySql).get());
}
const mean = (measurements: readonly Measurement[]): Measurement => {
  const average = (field: "score" | "coding" | "memory") =>
    measurements.reduce((sum, m) => sum + m[field], 0) / measurements.length;
  return {
    score: average("score"),
    coding: average("coding"),
    memory: average("memory"),
    tokens: measurements.some((m) => m.tokens === null)
      ? null
      : measurements.reduce((sum, m) => sum + (m.tokens ?? 0), 0) / measurements.length,
  };
};
const make = Effect.gen(function* () {
  const store = yield* HarnessStore;
  const { sqlite, atomic } = yield* Database;
  const pin = Effect.runPromiseWith(
    yield* Effect.context<OpenAICompatibleSettings | GlobalConfig | ProviderRegistry>(),
  );
  let controller: AbortController | null = null;
  let task: Promise<void> | null = null;
  let lastActivity = Date.now();
  let disposed = false;
  const originalFile = process.env.CONTEXT_AGENT_RRSI_ORIGINAL_STORAGE
    ? join(process.env.CONTEXT_AGENT_RRSI_ORIGINAL_STORAGE, "agent.db")
    : null;
  const original =
    originalFile && existsSync(originalFile)
      ? new DatabaseSync(originalFile, { readOnly: true })
      : null;
  const repo = process.env.CONTEXT_AGENT_RRSI_REPOSITORY ?? null;
  const touch = () => {
    lastActivity = Date.now();
    controller?.abort("user_activity");
  };
  const status = () => ({
    settings: store.settings(),
    current: store.current(),
    versions: store.versions(),
    experiments: store.experiments(),
    running: controller !== null,
    configuredRepository: repo !== null,
  });
  const branchCandidate = async (
    experimentId: string,
    round: number,
    index: number,
    profile: HarnessProfile,
  ) => {
    if (!repo) return { branch: null, commit: null };
    const branch = `rrsi/${experimentId}/${round}/${index}`;
    const directory = join(repo, ".rrsi-local/candidates", experimentId, `${round}-${index}`);
    mkdirSync(join(repo, ".rrsi-local/candidates", experimentId), { recursive: true });
    await run("git", ["worktree", "add", "-b", branch, directory, "HEAD"], { cwd: repo });
    writeFileSync(join(directory, "rrsi-profile.json"), JSON.stringify(profile, null, 2) + "\n");
    await run("git", ["add", "--", "rrsi-profile.json"], { cwd: directory });
    await run(
      "git",
      ["-c", "core.hooksPath=/dev/null", "commit", "-m", "experiment: propose harness profile"],
      { cwd: directory },
    );
    const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: directory });
    return { branch, commit: stdout.trim() };
  };
  const execute = async (
    record: MutableExperiment,
    client: ModelGateway,
    abort: AbortController,
  ) => {
    const settings = store.settings();
    const deadline = Date.now() + settings.maxMinutes * 60000;
    const consume = (raw: string) => {
      const count = reportedTokens(raw);
      if (count === null) {
        throw new Error("usage_unknown");
      }
      record.tokens += count;
      store.saveExperiment(record);
    };
    const bounded: ModelGateway = {
      ...client,
      complete: async (body, signal) => {
        if (signal.aborted || Date.now() >= deadline) throw new Error("experiment_stopped");
        return client.complete(body, signal);
      },
    };
    const request = async (instruction: string) => {
      const raw = await bounded.complete(
        JSON.stringify({
          messages: [{ role: "user", content: instruction }],
          response_format: { type: "json_object" },
        }),
        abort.signal,
      );
      consume(raw);
      return completionText(raw);
    };
    const evaluate = async (
      profile: HarnessProfile,
      split: "evolve" | "validation" | "sealed",
      trials = 2,
    ) => {
      const measurements: Measurement[] = [];
      for (let trial = 0; trial < trials; trial++)
        measurements.push(
          await evaluateSandbox(
            bounded,
            profile,
            split,
            abort.signal,
            consume,
            record.baselineImage,
          ),
        );
      return mean(measurements);
    };
    const timer = setTimeout(() => abort.abort("time_limit"), settings.maxMinutes * 60000);
    try {
      const base = store.get(record.baseVersion);
      let profile = base.profile;
      const baselines: Measurement[] = [];
      for (let repeat = 0; repeat < 3; repeat++)
        baselines.push(await evaluate(profile, "evolve", 1));
      record.baselines = baselines;
      store.saveExperiment(record);
      const delta = noiseBand(baselines.map((m) => m.score));
      let incumbent = mean(baselines);
      if (incumbent.coding === 0 || incumbent.memory === 0) {
        record.reason = "baseline_quality_failed";
        return;
      }
      let best = incumbent.score;
      for (let round = 0; round < 2; round++) {
        const admissible: {
          profile: HarnessProfile;
          measurement: Measurement;
          recordId: string;
        }[] = [];
        for (let index = 0; index < 2; index++) {
          const proposal = Schema.decodeUnknownSync(Schema.fromJsonString(Proposal))(
            await request(
              [
                "Propose one reusable agent harness improvement. Return JSON {profile:{rolePrompt,memoryToolDescription,retrievalLeadLimit,retrievalTokenLimit},edits:[{component,hypothesis}]}.",
                "Do not change user instructions, permissions, authentication, evaluation or safety rules. Keep tool descriptions consistent with existing behavior. Do not encode task identifiers, answers or fixtures.",
                `Independent edit budget: ${editBudget(round, 2)}. Profile: ${JSON.stringify(profile)}.`,
                `Untried components: ${exploration(record.candidates).join(", ")}. Prefer untried mechanisms if progress stalls; propose removing earlier additions that produced no positive evidence.`,
                `Measured history (including failures): ${JSON.stringify(record.candidates)}`,
              ].join("\n"),
            ),
          );
          const changed = Object.keys(profile).filter((key) => {
            // SAFETY: keys originate in the fixed decoded profile, not in arbitrary model output.
            const field = key as keyof HarnessProfile;
            return profile[field] !== proposal.profile[field];
          }).length;
          let decision = "pending";
          if (
            changed === 0 ||
            changed > editBudget(round, 2) ||
            proposal.edits.length === 0 ||
            proposal.edits.length > editBudget(round, 2)
          )
            decision = "edit_budget";
          if (
            /(decision-\d|obsolete-\d|(?:evolve|validation|sealed)-(?:coding|memory)-)/.test(
              JSON.stringify(proposal.profile),
            )
          )
            decision = "task_leakage";
          const candidate: MutableCandidate = {
            kind: "profile",
            imageId: null,
            id: randomUUID(),
            round,
            profile: proposal.profile,
            edits: proposal.edits,
            measurement: null,
            decision,
            diff: JSON.stringify({ before: profile, after: proposal.profile }, null, 2),
            branch: null,
            commit: null,
          };
          record.candidates.push(candidate);
          store.saveExperiment(record);
          if (decision !== "pending") continue;
          const critique = Schema.decodeUnknownSync(Schema.fromJsonString(Critique))(
            await request(
              `Review candidate diff for task-specific logic, contradictory tool behavior, disabled verification or overridden permissions. Return only {"approved":true|false}. Diff: ${candidate.diff}`,
            ),
          );
          if (!critique.approved) {
            candidate.decision = "critic_rejected";
            store.saveExperiment(record);
            continue;
          }
          Object.assign(
            candidate,
            await branchCandidate(record.id, round, index, proposal.profile),
          );
          candidate.measurement = await evaluate(proposal.profile, "evolve");
          const selection = selectCandidate(incumbent, candidate.measurement, {
            delta,
            bestScore: best,
            beta0: 0.1,
            beta1: 2,
          });
          candidate.decision = selection.kind === "accepted" ? "admissible" : selection.reason;
          if (selection.kind === "accepted")
            admissible.push({
              profile: proposal.profile,
              measurement: candidate.measurement,
              recordId: candidate.id,
            });
          store.saveExperiment(record);
        }
        admissible.sort((a, b) => b.measurement.score - a.measurement.score);
        const winner = admissible[0];
        if (winner) {
          profile = winner.profile;
          incumbent = winner.measurement;
          best = Math.max(best, incumbent.score);
          const winnerRecord = record.candidates.find(
            (candidate) => candidate.id === winner.recordId,
          );
          if (winnerRecord) winnerRecord.decision = "round_winner";
        }
        store.saveExperiment(record);
      }
      if (JSON.stringify(profile) === JSON.stringify(base.profile)) {
        record.reason = "no_admissible_candidate";
        return;
      }
      const validationBase = await evaluate(base.profile, "validation");
      const validationNew = await evaluate(profile, "validation");
      record.validationBase = validationBase;
      record.validationNew = validationNew;
      store.saveExperiment(record);
      if (
        selectCandidate(validationBase, validationNew, {
          delta,
          bestScore: validationBase.score,
          beta0: 0.1,
          beta1: 2,
        }).kind !== "accepted"
      ) {
        record.reason = "validation_rejected";
        return;
      }
      // A held-out suite cannot silently turn into a repeatedly queried training suite.
      atomic(() => {
        sqlite.prepare("INSERT INTO rrsi_corpus_receipts VALUES ('v1', ?)").run(record.id);
      });
      const sealedBase = await evaluate(base.profile, "sealed");
      const sealedNew = await evaluate(profile, "sealed");
      record.sealedBase = sealedBase;
      record.sealedNew = sealedNew;
      store.saveExperiment(record);
      if (
        selectCandidate(sealedBase, sealedNew, {
          delta,
          bestScore: sealedBase.score,
          beta0: 0.1,
          beta1: 2,
        }).kind !== "accepted"
      ) {
        record.reason = "heldout_rejected";
        return;
      }
      if (abort.signal.aborted) throw new Error("experiment_stopped");
      const winner = record.candidates.findLast(
        (candidate) => candidate.decision === "round_winner",
      );
      store.adopt(profile, record.baseVersion, winner?.commit ?? null);
      record.reason = "profile_adopted";
      if (repo) {
        // Code is still review-only. An approved profile remains installed if code exploration fails.
        try {
          const proposal = Schema.decodeUnknownSync(Schema.fromJsonString(CodeProposal))(
            await request(
              [
                "Propose one reusable code improvement. Return JSON {edits:[{component,hypothesis}],files:[{path,before,after}]}. Use exact unique replacement anchors; touch at most three allowed files. Do not modify permissions, authentication, evaluator, tests, runtime version management or user instructions.",
                `Source: ${JSON.stringify(codeContext(repo))}`,
                `Measured profile history: ${JSON.stringify(record.candidates)}`,
              ].join("\n"),
            ),
          );
          const candidate: MutableCandidate = {
            kind: "code",
            imageId: null,
            id: randomUUID(),
            round: 2,
            profile,
            edits: proposal.edits,
            measurement: null,
            decision: "code_validating",
            diff: JSON.stringify(proposal.files, null, 2),
            branch: null,
            commit: null,
          };
          record.candidates.push(candidate);
          store.saveExperiment(record);
          const critique = Schema.decodeUnknownSync(Schema.fromJsonString(Critique))(
            await request(
              `Review the code replacements for benchmark leakage, altered verification, credentials, changed permissions or inert machinery. Return {"approved":true|false}. ${candidate.diff}`,
            ),
          );
          if (!critique.approved) {
            candidate.decision = "critic_rejected";
            return;
          }
          const code = await prepareCodeCandidate(repo, record.id, proposal, abort.signal);
          candidate.branch = code.branch;
          candidate.commit = code.commit;
          candidate.diff = code.diff;
          candidate.imageId = code.image;
          candidate.measurement = mean([
            await evaluateSandbox(
              bounded,
              profile,
              "validation",
              abort.signal,
              consume,
              code.image,
            ),
            await evaluateSandbox(
              bounded,
              profile,
              "validation",
              abort.signal,
              consume,
              code.image,
            ),
          ]);
          const selection = selectCandidate(validationNew, candidate.measurement, {
            delta,
            bestScore: validationNew.score,
            beta0: 0.1,
            beta1: 2,
          });
          candidate.decision =
            selection.kind === "accepted" ? "code_review_pending" : selection.reason;
        } catch {
          const candidate = record.candidates.findLast((entry) => entry.kind === "code");
          if (candidate) candidate.decision = "code_evaluation_incomplete";
        } finally {
          store.saveExperiment(record);
        }
      }
    } finally {
      clearTimeout(timer);
    }
  };
  const start = Effect.fn("Rrsi.start")(function* () {
    if (controller !== null) return yield* new RrsiFailed({ reason: "experiment_running" });
    if (sqlite.prepare("SELECT 1 FROM rrsi_corpus_receipts WHERE version='v1'").get())
      return yield* new RrsiFailed({ reason: "sealed_corpus_exhausted" });
    const baselineImage = yield* Effect.tryPromise({
      try: async () => {
        const { stdout } = await run("docker", [
          "image",
          "inspect",
          "context-agent-rrsi:local",
          "--format",
          "{{.Id}}",
        ]);
        const image = stdout.trim();
        if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("invalid_image");
        return image;
      },
      catch: () => new RrsiFailed({ reason: "evaluation_image_unavailable" }),
    });
    // Pin immutable evaluator provenance before any requests or candidates are created.
    if (controller !== null) return yield* new RrsiFailed({ reason: "experiment_running" });
    const client = yield* pinModelGateway().pipe(
      Effect.mapError(() => new RrsiFailed({ reason: "model_unavailable" })),
    );
    if (controller !== null) {
      client.release();
      return yield* new RrsiFailed({ reason: "experiment_running" });
    }
    const abort = new AbortController();
    const record: MutableExperiment = {
      id: randomUUID(),
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      provider: client.configuration.provider,
      model: client.configuration.model,
      endpoint: client.configuration.baseUrl,
      baseVersion: store.current().id,
      baselineImage,
      tokens: 0,
      reason: "",
      candidates: [],
    };
    yield* Effect.try({
      try: () => store.saveExperiment(record),
      catch: () => new RrsiFailed({ reason: "state_operation_failed" }),
    }).pipe(Effect.onError(() => Effect.sync(client.release)));
    controller = abort;
    task = execute(record, client, abort)
      .then(
        () => {
          record.status = abort.signal.aborted ? "cancelled" : "completed";
          if (abort.signal.aborted) record.reason = experimentFailure(null, abort.signal);
        },
        (error: Error) => {
          record.status = abort.signal.aborted ? "cancelled" : "failed";
          record.reason = experimentFailure(error, abort.signal);
        },
      )
      .finally(() => {
        record.finishedAt = Date.now();
        try {
          store.saveExperiment(record);
        } finally {
          client.release();
          controller = null;
        }
      });
    return { experimentId: record.id };
  });
  const tick = async () => {
    if (disposed || process.env.CONTEXT_AGENT_RRSI_WORKER === "1") return;
    const local = activity(sqlite);
    const remote = original ? activity(original) : { busy: 0, latest: null };
    if (local.busy || remote.busy) {
      touch();
      return;
    }
    const latest = Math.max(lastActivity, local.latest ?? 0, remote.latest ?? 0);
    if (!store.settings().enabled || controller || Date.now() - latest < 600000) return;
    if (store.experiments().some((entry) => entry.startedAt > Date.now() - 86400000)) return;
    await pin(start()).catch(() => undefined);
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const interval = setInterval(() => {
        void tick().catch(() => {
          controller?.abort("activity_check_failed");
        });
      }, 1000);
      interval.unref();
      return interval;
    }),
    (interval) =>
      Effect.promise(async () => {
        disposed = true;
        clearInterval(interval);
        controller?.abort("app_shutdown");
        await task;
        original?.close();
      }),
  );
  const wrap = <A>(operation: () => A) =>
    Effect.try({
      try: operation,
      catch: () => new RrsiFailed({ reason: "state_operation_failed" }),
    });
  return {
    status: Effect.sync(status),
    start,
    touch,
    stop: Effect.sync(() => {
      controller?.abort("manual_stop");
      return { stopped: true };
    }),
    configure: (settings: RrsiSettings) =>
      wrap(() => {
        store.configure(settings);
        if (!settings.enabled) controller?.abort("disabled");
        return status();
      }),
    restore: (id: string) =>
      wrap(() => {
        controller?.abort("profile_restored");
        store.restore(id);
        return status();
      }),
  };
});
export class Rrsi extends Context.Service<Rrsi, Effect.Success<typeof make>>()(
  "memory-agent/rrsi/Rrsi",
) {
  static readonly layer = Layer.effect(Rrsi, make);
}
