import { nativePromise, runNativeEffect } from "../runtime/native-effect.ts";
import { Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
import { oauthProtocolCrypto } from "../oauth/node-runtime.ts";
// A second, read-only owner database is a native SQLite file opened only for activity reads.
import { DatabaseSync } from "node:sqlite";
import { oauthProtocolFileSystem as fs } from "../oauth/node-runtime.ts";
import { oauthProtocolPath } from "../oauth/node-runtime.ts";
import { runProcess } from "./command.ts";
const run = (
  command: string,
  args: readonly string[],
  options: Omit<Parameters<typeof runProcess>[0], "command" | "args"> = {},
) => runProcess({ command, args, ...options });
import {
  Clock,
  ConfigProvider,
  Option,
  Predicate,
  Config,
  Context,
  Effect,
  Fiber,
  Layer,
  Schedule,
  Schema,
  Scope,
} from "effect";
import { SqlClient } from "effect/sql";
import { connectionContext } from "../db/database.ts";
import { OpenAICompatibleSettings } from "../providers/openai-compatible.ts";
import { GlobalConfig } from "../config/global-config.ts";
import { ProviderRegistry } from "../providers/registry.ts";
import { pinModelGateway, type ModelGateway } from "./model-gateway.ts";
import { HarnessStore } from "./store.ts";
import {
  Proposal,
  type ExperimentProgress,
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
import { EvaluationFailed, experimentFailure } from "./failure.ts";
import { readActivity } from "./activity.ts";
import { SdkCancellations } from "../runtime/sdk-cancellation.ts";
import { sdkPromiseWithController } from "../runtime/sdk-promise.ts";

export class RrsiFailed extends Schema.TaggedError<RrsiFailed>()("RrsiFailed", {
  reason: Schema.Literals([
    "evaluation_image_unavailable",
    "experiment_running",
    "state_operation_failed",
    "sealed_corpus_exhausted",
    "model_unavailable",
    "evaluation_incomplete",
    /** The host environment or the original store named by it could not be read. */
    "configuration_failed",
  ]),
}) {}

/** Native evaluator and model boundaries, independent of the experiment's lifecycle. */
export class RrsiExecution extends Context.Service<
  RrsiExecution,
  {
    readonly image: Effect.Effect<string, RrsiFailed>;
    readonly pinModel: typeof pinModelGateway;
    readonly evaluate: typeof evaluateSandbox;
  }
>()("memory-agent/rrsi/service/RrsiExecution") {
  static readonly layer = Layer.succeed(RrsiExecution, {
    image: Effect.tryPromise({
      try: () =>
        run("docker", ["image", "inspect", "context-agent-rrsi:local", "--format", "{{.Id}}"]),
      catch: () => RrsiFailed.make({ reason: "evaluation_image_unavailable" }),
    }).pipe(
      Effect.flatMap(({ stdout }) => {
        const image = stdout.trim();
        return /^sha256:[a-f0-9]{64}$/.test(image)
          ? Effect.succeed(image)
          : Effect.fail(RrsiFailed.make({ reason: "evaluation_image_unavailable" }));
      }),
    ),
    pinModel: pinModelGateway,
    evaluate: evaluateSandbox,
  });
}
type MutableCandidate = { -readonly [K in keyof CandidateRecord]: CandidateRecord[K] };
type MutableExperiment = {
  -readonly [K in keyof Omit<ExperimentRecord, "candidates">]: ExperimentRecord[K];
} & { candidates: MutableCandidate[] };
const stringifyJson = <A>(value: A, _replacer?: null, space?: number) =>
  Result.getOrThrow(
    Schema.encodeResult(Schema.fromJsonString(Schema.Unknown, { space: space ?? 0 }))(value),
  );
const Completion = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({ message: Schema.Struct({ content: Schema.NullOr(Schema.String) }) }),
  ),
});
const completionText = (raw: string) =>
  // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
  EffectFunction.flow(
    Schema.decodeResult(Schema.fromJsonString(Completion)),
    Result.getOrThrow,
  )(raw).choices[0]?.message.content ?? "";
const Critique = Schema.Struct({ approved: Schema.Boolean });
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
  const effectClock = yield* Clock.Clock;
  const cancellations = yield* SdkCancellations;
  const native = yield* RrsiExecution;
  const owner = yield* Scope.fork(yield* Effect.scope);

  const store = yield* HarnessStore;
  const sql = yield* SqlClient.SqlClient;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const dependencies = yield* Effect.context<
    OpenAICompatibleSettings | GlobalConfig | ProviderRegistry
  >();
  let controller: AbortController | null = null;
  let task: Fiber.Fiber<void> | null = null;
  let lastActivity = yield* Clock.currentTimeMillis;
  let disposed = false;
  const configurationFailed = () => RrsiFailed.make({ reason: "configuration_failed" });
  const originalStorage = yield* Config.String("CONTEXT_AGENT_RRSI_ORIGINAL_STORAGE")
    .pipe(Config.withDefault(""))
    .parse(ConfigProvider.fromEnv())
    .pipe(Effect.mapError(configurationFailed));
  const originalFile = isTruthy(originalStorage)
    ? oauthProtocolPath.join(originalStorage, "agent.db")
    : null;
  // The original store is read-only evidence; its connection closes after the poller stops.
  const originalContext =
    originalFile !== null &&
    (yield* fs.exists(originalFile).pipe(Effect.mapError(configurationFailed)))
      ? yield* Effect.acquireRelease(
          Effect.sync(() => new DatabaseSync(originalFile, { readOnly: true })),
          (original) => Effect.sync(() => original.close()),
        ).pipe(Effect.flatMap(connectionContext))
      : null;
  const repo = Option.getOrNull(
    yield* Config.String("CONTEXT_AGENT_RRSI_REPOSITORY")
      .pipe(Config.option)
      .parse(ConfigProvider.fromEnv())
      .pipe(Effect.mapError(configurationFailed)),
  );
  const touch = () => {
    lastActivity = effectClock.currentTimeMillisUnsafe();
    controller?.abort("user_activity");
  };
  const status = Effect.all({
    settings: store.settings,
    current: store.current,
    versions: store.versions,
    experiments: store.experiments,
  }).pipe(
    Effect.map((stored) => ({
      ...stored,
      running: controller !== null,
      configuredRepository: repo !== null,
    })),
  );
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const branchCandidate = Effect.fn("Rrsi.branchCandidate")(function* (
    experimentId: string,
    round: number,
    index: number,
    profile: HarnessProfile,
  ) {
    if (!isTruthy(repo)) return { branch: null, commit: null };
    const branch = `rrsi/${experimentId}/${round}/${index}`;
    const directory = oauthProtocolPath.join(
      repo,
      ".rrsi-local/candidates",
      experimentId,
      `${round}-${index}`,
    );
    yield* fs.makeDirectory(oauthProtocolPath.join(repo, ".rrsi-local/candidates", experimentId), {
      recursive: true,
    });
    yield* nativePromise(() =>
      run("git", ["worktree", "add", "-b", branch, directory, "HEAD"], { cwd: repo }),
    );
    yield* fs.writeFileString(
      oauthProtocolPath.join(directory, "rrsi-profile.json"),
      stringifyJson(profile, null, 2) + "\n",
    );
    yield* nativePromise(() => run("git", ["add", "--", "rrsi-profile.json"], { cwd: directory }));
    yield* nativePromise(() =>
      run(
        "git",
        ["-c", "core.hooksPath=/dev/null", "commit", "-m", "experiment: propose harness profile"],
        { cwd: directory },
      ),
    );
    const { stdout } = yield* nativePromise(() =>
      run("git", ["rev-parse", "HEAD"], { cwd: directory }),
    );
    return { branch, commit: stdout.trim() };
  });
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const executeEffect = Effect.fn("Rrsi.execute")(function* (
    record: MutableExperiment,
    client: ModelGateway,
    abort: AbortController,
  ) {
    const settings = yield* store.settings;
    // Native evaluator callbacks report progress synchronously; their saves run in this runtime,
    // owned by the service Scope so none outlives its connection.
    // A later save always writes the latest record, so an earlier one finishing last loses nothing.
    const saveLater = () =>
      void runFork(
        Effect.forkIn(
          store
            .saveExperiment(record)
            .pipe(Effect.catch((error) => Effect.logWarning("rrsi_progress_not_saved", error))),
          owner,
        ),
      );
    const deadline = effectClock.currentTimeMillisUnsafe() + settings.maxMinutes * 60000;
    const progress = (
      phase: (typeof ExperimentProgress.Type)["phase"],
      completed: number,
      total: number,
    ) => {
      record.progress = { phase, completed, total };
      saveLater();
    };
    const consume = (raw: string) => {
      const count = reportedTokens(raw);
      if (count === null) {
        throw EvaluationFailed.make({ reason: "usage_unknown" });
      }
      record.tokens += count;
      saveLater();
    };
    const bounded: ModelGateway = {
      ...client,
      // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
      complete: (body, signal) =>
        runNativeEffect(
          Effect.gen(function* () {
            if (effectClock.currentTimeMillisUnsafe() >= deadline) abort.abort("time_limit");
            if (signal.aborted || abort.signal.aborted)
              return yield* EvaluationFailed.make({ reason: "evaluation_incomplete" });
            return yield* nativePromise(() => client.complete(body, signal));
          }),
        ),
    };
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    const request = Effect.fn("Rrsi.proposalRequest")(function* (instruction: string) {
      const raw = yield* nativePromise(() =>
        bounded.complete(
          stringifyJson({
            messages: [{ role: "user", content: instruction }],
            response_format: { type: "json_object" },
          }),
          abort.signal,
        ),
      );
      const protocolInvalid = () => EvaluationFailed.make({ reason: "protocol_invalid" });
      const count = yield* Effect.try({ try: () => reportedTokens(raw), catch: protocolInvalid });
      if (count === null) return yield* EvaluationFailed.make({ reason: "usage_unknown" });
      record.tokens += count;
      saveLater();
      return yield* Effect.try({ try: () => completionText(raw), catch: protocolInvalid });
    });
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    const evaluate = Effect.fn("Rrsi.evaluate")(function* (
      profile: HarnessProfile,
      split: "evolve" | "validation" | "sealed",
      trials = 2,
      phase: (typeof ExperimentProgress.Type)["phase"] = "candidate_evaluation",
      completedOffset = 0,
      total = trials * (split === "evolve" ? 12 : 6),
    ) {
      const measurements: Measurement[] = [];
      const tasksPerTrial = split === "evolve" ? 12 : 6;
      progress(phase, completedOffset, total);
      for (let trial = 0; trial < trials; trial++) {
        measurements.push(
          yield* nativePromise(() =>
            native.evaluate({
              client: bounded,
              profile,
              split: split,
              signal: abort.signal,
              consume,
              image: record.baselineImage,
              onProgress: (completed) =>
                progress(phase, completedOffset + trial * tasksPerTrial + completed, total),
            }),
          ),
        );
        progress(phase, completedOffset + (trial + 1) * tasksPerTrial, total);
      }
      return mean(measurements);
    });
    const timer = yield* Effect.sleep(settings.maxMinutes * 60000).pipe(
      Effect.andThen(Effect.sync(() => abort.abort("time_limit"))),
      Effect.forkChild,
    );
    yield* Effect.gen(function* () {
      const base = yield* store.get(record.baseVersion);
      let profile = base.profile;
      const baselines: Measurement[] = [];
      for (let repeat = 0; repeat < 3; repeat++) {
        baselines.push(yield* evaluate(profile, "evolve", 1, "baseline", repeat * 12, 36));
        record.baselines = [...baselines];
        yield* store.saveExperiment(record);
      }
      const delta = noiseBand(baselines.map((m) => m.score));
      let incumbent = mean(baselines);
      // A completed zero-score baseline is precisely a domain that can need improvement.
      // Infrastructure failures never reach selection; evaluateSandbox fails them explicitly.
      let best = incumbent.score;
      for (let round = 0; round < 2; round++) {
        const admissible: {
          profile: HarnessProfile;
          measurement: Measurement;
          recordId: string;
        }[] = [];
        for (let index = 0; index < 2; index++) {
          progress("proposal", 0, 1);
          const proposal = yield* Schema.decodeEffect(Schema.fromJsonString(Proposal))(
            yield* request(
              [
                "Propose one reusable agent harness improvement. Return JSON {profile:{rolePrompt,memoryToolDescription,retrievalLeadLimit,retrievalTokenLimit},edits:[{component,hypothesis}]}.",
                "Do not change user instructions, permissions, authentication, evaluation or safety rules. Keep tool descriptions consistent with existing behavior. Do not encode task identifiers, answers or fixtures.",
                `Independent edit budget: ${editBudget(round, 2)}. Profile: ${stringifyJson(profile)}.`,
                `Untried components: ${exploration(record.candidates).join(", ")}. Prefer untried mechanisms if progress stalls; propose removing earlier additions that produced no positive evidence.`,
                `Measured history (including failures): ${stringifyJson(record.candidates)}`,
              ].join("\n"),
            ),
          );
          progress("proposal", 1, 1);
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
              stringifyJson(proposal.profile),
            )
          )
            decision = "task_leakage";
          const candidate: MutableCandidate = {
            kind: "profile",
            imageId: null,
            id: yield* oauthProtocolCrypto.randomUUIDv4(),
            round,
            profile: proposal.profile,
            edits: proposal.edits,
            measurement: null,
            decision,
            diff: stringifyJson({ before: profile, after: proposal.profile }, null, 2),
            branch: null,
            commit: null,
          };
          record.candidates.push(candidate);
          yield* store.saveExperiment(record);
          if (decision !== "pending") continue;
          progress("critique", 0, 1);
          const critique = yield* Schema.decodeEffect(Schema.fromJsonString(Critique))(
            yield* request(
              `Review candidate diff for task-specific logic, contradictory tool behavior, disabled verification or overridden permissions. Return only {"approved":true|false}. Diff: ${candidate.diff}`,
            ),
          );
          progress("critique", 1, 1);
          if (!critique.approved) {
            candidate.decision = "critic_rejected";
            yield* store.saveExperiment(record);
            continue;
          }
          Object.assign(
            candidate,
            yield* branchCandidate(record.id, round, index, proposal.profile),
          );
          candidate.measurement = yield* evaluate(proposal.profile, "evolve");
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
          yield* store.saveExperiment(record);
        }
        admissible.sort((a, b) => b.measurement.score - a.measurement.score);
        const winner = admissible[0];
        if (isTruthy(winner)) {
          profile = winner.profile;
          incumbent = winner.measurement;
          best = Math.max(best, incumbent.score);
          const winnerRecord = record.candidates.find(
            (candidate) => candidate.id === winner.recordId,
          );
          if (isTruthy(winnerRecord)) winnerRecord.decision = "round_winner";
        }
        yield* store.saveExperiment(record);
      }
      if (stringifyJson(profile) === stringifyJson(base.profile)) {
        record.reason = "no_admissible_candidate";
        return;
      }
      const validationBase = yield* evaluate(base.profile, "validation", 2, "validation", 0, 24);
      const validationNew = yield* evaluate(profile, "validation", 2, "validation", 12, 24);
      record.validationBase = validationBase;
      record.validationNew = validationNew;
      yield* store.saveExperiment(record);
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
      yield* sql`INSERT INTO rrsi_corpus_receipts VALUES ('v1', ${record.id})`;
      const sealedBase = yield* evaluate(base.profile, "sealed", 2, "sealed", 0, 24);
      const sealedNew = yield* evaluate(profile, "sealed", 2, "sealed", 12, 24);
      record.sealedBase = sealedBase;
      record.sealedNew = sealedNew;
      yield* store.saveExperiment(record);
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
      if (abort.signal.aborted)
        return yield* EvaluationFailed.make({ reason: "evaluation_incomplete" });
      const winner = record.candidates.findLast(
        (candidate) => candidate.decision === "round_winner",
      );
      record.adoptedVersionId = (yield* store.adopt(
        profile,
        record.baseVersion,
        winner?.commit ?? null,
      )).id;
      record.reason = "profile_adopted";
      yield* store.saveExperiment(record);
      if (isTruthy(repo)) {
        // Code is still review-only. An approved profile remains installed if code exploration fails.
        yield* Effect.gen(function* () {
          progress("code_proposal", 0, 1);
          const proposal = yield* Schema.decodeEffect(Schema.fromJsonString(CodeProposal))(
            yield* request(
              [
                "Propose one reusable code improvement. Return JSON {edits:[{component,hypothesis}],files:[{path,before,after}]}. Use exact unique replacement anchors; touch at most three allowed files. Do not modify permissions, authentication, evaluator, tests, runtime version management or user instructions.",
                `Source: ${stringifyJson(yield* codeContext(repo))}`,
                `Measured profile history: ${stringifyJson(record.candidates)}`,
              ].join("\n"),
            ),
          );
          progress("code_proposal", 1, 1);
          const candidate: MutableCandidate = {
            kind: "code",
            imageId: null,
            id: yield* oauthProtocolCrypto.randomUUIDv4(),
            round: 2,
            profile,
            edits: proposal.edits,
            measurement: null,
            decision: "code_validating",
            diff: stringifyJson(proposal.files, null, 2),
            branch: null,
            commit: null,
          };
          record.candidates.push(candidate);
          yield* store.saveExperiment(record);
          progress("critique", 0, 1);
          const critique = yield* Schema.decodeEffect(Schema.fromJsonString(Critique))(
            yield* request(
              `Review the code replacements for benchmark leakage, altered verification, credentials, changed permissions or inert machinery. Return {"approved":true|false}. ${candidate.diff}`,
            ),
          );
          progress("critique", 1, 1);
          if (!critique.approved) {
            candidate.decision = "critic_rejected";
            return;
          }
          progress("code_build", 0, 1);
          const code = yield* nativePromise(() =>
            prepareCodeCandidate(repo, record.id, proposal, abort.signal),
          );
          progress("code_build", 1, 1);
          progress("code_validation", 0, 12);
          candidate.branch = code.branch;
          candidate.commit = code.commit;
          candidate.diff = code.diff;
          candidate.imageId = code.image;
          candidate.measurement = mean([
            yield* nativePromise(() =>
              native.evaluate({
                client: bounded,
                profile,
                split: "validation",
                signal: abort.signal,
                consume,
                image: code.image,
                onProgress: (completed) => progress("code_validation", completed, 12),
              }),
            ),
            yield* nativePromise(() =>
              native.evaluate({
                client: bounded,
                profile,
                split: "validation",
                signal: abort.signal,
                consume,
                image: code.image,
                onProgress: (completed) => progress("code_validation", 6 + completed, 12),
              }),
            ),
          ]);
          progress("code_validation", 12, 12);
          const selection = selectCandidate(validationNew, candidate.measurement, {
            delta,
            bestScore: validationNew.score,
            beta0: 0.1,
            beta1: 2,
          });
          candidate.decision =
            selection.kind === "accepted" ? "code_review_pending" : selection.reason;
        }).pipe(
          // Any expected failure of code exploration, an unreadable model answer included, leaves
          // the adopted profile in place. Defects and interruption end the experiment.
          Effect.catch(() =>
            Effect.sync(() => {
              const candidate = record.candidates.findLast((entry) => entry.kind === "code");
              if (isTruthy(candidate)) candidate.decision = "code_evaluation_incomplete";
            }),
          ),
          Effect.ensuring(
            store
              .saveExperiment(record)
              .pipe(
                Effect.catch((error) => Effect.logWarning("rrsi_code_record_not_saved", error)),
              ),
          ),
        );
      }
    }).pipe(Effect.ensuring(Fiber.interrupt(timer)));
  });
  const execute = (record: MutableExperiment, client: ModelGateway, abort: AbortController) =>
    runNativeEffect(executeEffect(record, client, abort));
  const start = Effect.fn("Rrsi.start")(function* () {
    const effectClock = yield* Clock.Clock;

    if (controller !== null) return yield* RrsiFailed.make({ reason: "experiment_running" });
    const exhausted = yield* sql`SELECT 1 FROM rrsi_corpus_receipts WHERE version='v1'`.pipe(
      Effect.mapError(() => RrsiFailed.make({ reason: "state_operation_failed" })),
    );
    if (exhausted.length > 0) return yield* RrsiFailed.make({ reason: "sealed_corpus_exhausted" });
    // Named before the model is pinned, so a failure here has nothing to release.
    const experimentId = yield* oauthProtocolCrypto
      .randomUUIDv4()
      .pipe(Effect.mapError(() => RrsiFailed.make({ reason: "state_operation_failed" })));
    const baselineImage = yield* native.image;
    // Pin immutable evaluator provenance before any requests or candidates are created.
    if (controller !== null) return yield* RrsiFailed.make({ reason: "experiment_running" });
    const client = yield* native
      .pinModel()
      .pipe(Effect.mapError(() => RrsiFailed.make({ reason: "model_unavailable" })));
    if (controller !== null) {
      client.release();
      return yield* RrsiFailed.make({ reason: "experiment_running" });
    }
    const cancellation = yield* cancellations.allocate("app_shutdown");
    const abort = cancellation.controller;
    const record: MutableExperiment = {
      id: experimentId,
      status: "running",
      startedAt: yield* Clock.currentTimeMillis,
      finishedAt: null,
      provider: client.configuration.provider,
      model: client.configuration.model,
      endpoint: client.configuration.baseUrl,
      baseVersion: (yield* store.current.pipe(
        Effect.mapError(() => RrsiFailed.make({ reason: "state_operation_failed" })),
      )).id,
      baselineImage,
      tokens: 0,
      reason: "",
      candidates: [],
    };
    yield* store.saveExperiment(record).pipe(
      Effect.mapError(() => RrsiFailed.make({ reason: "state_operation_failed" })),
      Effect.onError(() => Effect.sync(client.release).pipe(Effect.ensuring(cancellation.cancel))),
    );
    controller = abort;
    const experiment = Effect.suspend(() => {
      const pending = execute(record, client, abort);
      // Interruption waits for the native evaluator's finally before releasing its client.
      return sdkPromiseWithController(() => pending, abort).pipe(
        Effect.onInterrupt(() => Effect.sync(() => abort.abort("app_shutdown"))),
        Effect.ensuring(
          Effect.tryPromise({
            try: () => pending,
            catch: () => RrsiFailed.make({ reason: "evaluation_incomplete" }),
          }).pipe(Effect.exit, Effect.asVoid),
        ),
      );
    }).pipe(
      Effect.matchEffect({
        onSuccess: () =>
          Effect.sync(() => {
            record.status = abort.signal.aborted ? "cancelled" : "completed";
            if (abort.signal.aborted) record.reason = experimentFailure(null, abort.signal);
          }),
        onFailure: (error) =>
          Effect.sync(() => {
            record.status = abort.signal.aborted ? "cancelled" : "failed";
            record.reason = experimentFailure(
              Predicate.isError(error.cause) ? error.cause : null,
              abort.signal,
            );
          }),
      }),
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          record.status = "cancelled";
          record.reason = experimentFailure(null, abort.signal);
        }),
      ),
      Effect.ensuring(
        Effect.suspend(() => {
          record.finishedAt = effectClock.currentTimeMillisUnsafe();
          return store.saveExperiment(record);
        }).pipe(
          Effect.mapError(() => RrsiFailed.make({ reason: "state_operation_failed" })),
          Effect.ensuring(
            Effect.sync(() => {
              client.release();
              controller = null;
            }),
          ),
          Effect.catchTag("RrsiFailed", (error) => Effect.logError(error)),
          Effect.ensuring(cancellation.release),
        ),
      ),
    );
    // This fiber owns the experiment; cancellation.release is a separate SDK resource scope.
    task = yield* Effect.forkIn(experiment, owner, { startImmediately: true });
    return { experimentId: record.id };
  });
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const tick = Effect.fn("Rrsi.tick")(function* () {
    // Native host/SDK configuration boundary reads or forwards the host environment.
    if (disposed) return;
    const worker = yield* Config.String("CONTEXT_AGENT_RRSI_WORKER")
      .pipe(Config.withDefault("0"))
      .parse(ConfigProvider.fromEnv());
    if (worker === "1") return;
    const local = yield* readActivity;
    const remote =
      originalContext !== null
        ? yield* Effect.provideContext(readActivity, originalContext)
        : { busy: 0, latest: null };
    if (isTruthy(local.busy) || isTruthy(remote.busy)) {
      touch();
      return;
    }
    const latest = Math.max(lastActivity, local.latest ?? 0, remote.latest ?? 0);
    if (
      !(yield* store.settings).enabled ||
      controller !== null ||
      effectClock.currentTimeMillisUnsafe() - latest < 600000
    )
      return;
    if (
      (yield* store.experiments).some(
        (entry) => entry.startedAt > effectClock.currentTimeMillisUnsafe() - 86400000,
      )
    )
      return;
    // An automatic start that is refused (already running, no image or model, corpus spent) waits
    // for the next idle window.
    yield* start().pipe(
      Effect.provideContext(dependencies),
      Effect.catchTag("RrsiFailed", (failure) =>
        Effect.logDebug("rrsi_auto_start_refused", { reason: failure.reason }),
      ),
    );
  });
  // Poll fibers belong to this service; a long experiment must not delay activity checks.
  // A check that fails or breaks stops the running experiment; the next tick checks again. The
  // failure is logged by tag only, and a defect stays in this tick's exit.
  const activityCheckFailed = Effect.sync(() => {
    controller?.abort("activity_check_failed");
  });
  const poll = tick().pipe(
    Effect.tapDefect(() => activityCheckFailed),
    Effect.catch((error) =>
      Effect.logWarning("rrsi_activity_check_failed", { error: error._tag }).pipe(
        Effect.andThen(activityCheckFailed),
      ),
    ),
  );
  yield* poll.pipe(
    Effect.forkScoped,
    Effect.repeat({ schedule: Schedule.spaced(1000) }),
    Effect.delay(1000),
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      disposed = true;
      controller?.abort("app_shutdown");
      if (task !== null) yield* Fiber.interrupt(task);
    }),
  );
  const wrap = <A, E>(operation: Effect.Effect<A, E>) =>
    Effect.mapError(operation, () => RrsiFailed.make({ reason: "state_operation_failed" }));
  return {
    status: wrap(status),
    start,
    touch,
    stop: Effect.gen(function* () {
      controller?.abort("manual_stop");
      if (task !== null) yield* Fiber.interrupt(task);
      return { stopped: true };
    }),
    configure: (settings: RrsiSettings) =>
      wrap(
        store.configure(settings).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (!settings.enabled) controller?.abort("disabled");
            }),
          ),
          Effect.andThen(status),
        ),
      ),
    restore: (id: string) =>
      wrap(
        Effect.sync(() => controller?.abort("profile_restored")).pipe(
          Effect.andThen(store.restore(id)),
          Effect.andThen(status),
        ),
      ),
  };
});
export class Rrsi extends Context.Service<Rrsi, Effect.Success<typeof make>>()(
  "memory-agent/rrsi/service/Rrsi",
) {
  static layerWith(execution: Layer.Layer<RrsiExecution>) {
    return Layer.effect(Rrsi, make).pipe(
      Layer.provide(execution),
      Layer.provideMerge(SdkCancellations.layer),
    );
  }
  static readonly layer = Rrsi.layerWith(RrsiExecution.layer);
}
