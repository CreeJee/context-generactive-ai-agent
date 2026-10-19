import { nativePromise, runNativeEffect } from "../runtime/native-effect.ts";
import { ignoreLogged } from "../runtime/logged-failures.ts";
import { Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
import {
  oauthProtocolCrypto,
  oauthProtocolFileSystem,
  oauthProtocolPath,
} from "../oauth/node-runtime.ts";
import { runOAuthNodeEffect } from "../oauth/node-runtime.ts";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  Cause,
  Config,
  ConfigProvider,
  Effect,
  Array as EffectArray,
  Fiber,
  Option,
  Queue,
  Schema,
  Stream,
} from "effect";
import type { ModelGateway } from "./model-gateway.ts";
import type { HarnessProfile, Measurement } from "./contracts.ts";
import { EvaluationFailed, WorkerFailureReason } from "./failure.ts";
import { CompatibleCompletionRejected } from "../providers/openai-compatible.ts";

const Frame = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["request", "subscription-request"]),
    id: Schema.String,
    body: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("result"),
    results: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        domain: Schema.Literals(["coding", "memory"]),
        score: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
      }),
    ),
  }),
  Schema.Struct({ kind: Schema.Literal("failure"), reason: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("progress"),
    completed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    total: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
]);
/**
 * Read-only mounts for the usage corpus: its storage snapshot and the original storage's models.
 * Empty when no corpus was built, so memory tasks stay synthetic.
 */
const usageMounts = Effect.gen(function* () {
  const variable = (name: string) =>
    Config.option(Config.String(name))
      .parse(ConfigProvider.fromEnv())
      .pipe(Effect.orElseSucceed(() => Option.none<string>()));
  const repository = yield* variable("CONTEXT_AGENT_RRSI_REPOSITORY");
  const original = yield* variable("CONTEXT_AGENT_RRSI_ORIGINAL_STORAGE");
  if (Option.isNone(repository) || Option.isNone(original)) return [];
  const usage = oauthProtocolPath.join(repository.value, ".rrsi-local", "usage");
  const version = yield* oauthProtocolFileSystem
    .readFileString(oauthProtocolPath.join(usage, "current"))
    .pipe(
      Effect.map((text) => text.trim()),
      Effect.option,
    );
  if (Option.isNone(version) || version.value === "") return [];
  return [
    "-v",
    `${oauthProtocolPath.join(usage, version.value)}:/usage:ro`,
    "-v",
    `${oauthProtocolPath.join(original.value, "models")}:/models:ro`,
    // Anonymous volume for the writable storage copy; --rm removes it with the container.
    "-v",
    "/work",
    "-e",
    "CONTEXT_AGENT_RRSI_USAGE=/usage",
  ];
});
interface EvaluationState {
  result: Measurement | null;
  failure: EvaluationFailed | null;
}
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
export function evaluateSandbox(options: {
  readonly client: ModelGateway;
  readonly profile: HarnessProfile;
  readonly split: "evolve" | "validation" | "sealed" | "smoke";
  readonly signal: AbortSignal;
  readonly consume: (raw: string) => void;
  readonly image?: string | undefined;
  readonly onProgress?: ((completed: number, total: number) => void) | undefined;
}) {
  return evaluateSandboxBody(
    options.client,
    options.profile,
    options.split,
    options.signal,
    options.consume,
    options.image,
    options.onProgress,
  );
}
function evaluateSandboxBody(
  client: ModelGateway,
  profile: HarnessProfile,
  split: "evolve" | "validation" | "sealed" | "smoke",
  signal: AbortSignal,
  consume: (raw: string) => void,
  image = "context-agent-rrsi:local",
  onProgress?: (completed: number, total: number) => void,
): Promise<Measurement> {
  return runOAuthNodeEffect(
    Effect.gen(function* () {
      const name = `rrsi-${yield* oauthProtocolCrypto.randomUUIDv4()}`;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const input = yield* Queue.make<Uint8Array, Cause.Done>();
      const encoder = new TextEncoder();
      const usage = yield* usageMounts;
      const child = yield* spawner.spawn(
        ChildProcess.make(
          "docker",
          [
            "run",
            "--rm",
            "-i",
            "--name",
            name,
            "--network",
            "none",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--pids-limit",
            "128",
            "--memory",
            // The real embedder, morphology model and a full storage copy need more than fixtures.
            usage.length > 0 ? "4g" : "2g",
            "--cpus",
            "2",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,size=512m,mode=1777",
            "-e",
            "CONTEXT_AGENT_RRSI_WORKER=1",
            ...usage,
            image,
          ],
          {
            stdin: Stream.fromQueue(input),
            detached: false,
            windowsHide: true,
            forceKillAfter: "5 seconds",
          },
        ),
      );
      let totalTokens: number | null = 0;
      let modelCalls = 0;
      let completedTasks = 0;
      const expected = split === "evolve" ? 12 : split === "smoke" ? 2 : 6;
      const state: EvaluationState = {
        result: null,
        failure: null,
      };
      const abortEffect = Effect.gen(function* () {
        yield* spawner
          .exitCode(
            ChildProcess.make("docker", ["kill", name], {
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
              detached: false,
              windowsHide: true,
              forceKillAfter: "1 second",
            }),
          )
          .pipe(Effect.timeout(5000), ignoreLogged("rrsi_container_kill_failed"));
        yield* child
          .kill({ forceKillAfter: "1 second" })
          .pipe(ignoreLogged("rrsi_child_kill_failed"));
      });
      const abort = () => {
        void runNativeEffect(abortEffect);
      };
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          signal.removeEventListener("abort", abort);
          yield* Queue.shutdown(input);
          // An unknown state is treated as stopped, as before: the container runs with --rm.
          const running = yield* child.isRunning.pipe(
            Effect.catchTag("PlatformError", () =>
              Effect.as(Effect.logDebug("rrsi_child_state_unknown"), false),
            ),
          );
          if (running) yield* abortEffect;
        }),
      );
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      yield* Queue.offer(
        input,
        encoder.encode(
          `${stringifyJson({ kind: "initialize", profile, split, model: client.configuration.model, provider: client.configuration.provider, reasoningEffort: client.configuration.reasoningEffort })}\n`,
        ),
      );
      // Each host request completes before the next frame; the candidate has no network or credentials.
      const requests = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.startsWith("RRSI:")),
        Stream.runForEach(
          Effect.fnUntraced(function* (line) {
            const frame = yield* Schema.decodeEffect(Schema.fromJsonString(Frame))(
              line.slice(5),
            ).pipe(Effect.mapError(() => EvaluationFailed.make({ reason: "protocol_invalid" })));
            switch (frame.kind) {
              case "request":
              case "subscription-request": {
                if (frame.kind === "subscription-request" && client.protocol !== "subscription")
                  return yield* EvaluationFailed.make({ reason: "gateway_protocol_mismatch" });
                const raw = yield* nativePromise(() =>
                  frame.kind === "subscription-request" && client.protocol === "subscription"
                    ? client.subscription(frame.body, signal)
                    : client.complete(frame.body, signal),
                ).pipe(
                  Effect.mapError((error) =>
                    EvaluationFailed.make({
                      reason:
                        error.cause instanceof CompatibleCompletionRejected &&
                        error.cause.reason === "memory_capacity_exceeded"
                          ? "gateway_memory_limit"
                          : "gateway_request_failed",
                    }),
                  ),
                );
                modelCalls++;
                // `consume` is the owner's synchronous callback; it throws its own EvaluationFailed.
                const usage = yield* Effect.try({
                  try: () => {
                    consume(raw);
                    return reportedTokens(raw);
                  },
                  catch: (error) =>
                    Schema.is(EvaluationFailed)(error)
                      ? error
                      : EvaluationFailed.make({ reason: "protocol_invalid" }),
                });
                totalTokens = totalTokens === null || usage === null ? null : totalTokens + usage;
                yield* Queue.offer(
                  input,
                  encoder.encode(
                    `${stringifyJson({ kind: "response", id: frame.id, ok: true, body: raw })}\n`,
                  ),
                );
                break;
              }
              case "progress":
                if (
                  frame.total !== expected ||
                  frame.completed > expected ||
                  frame.completed < completedTasks
                )
                  return yield* EvaluationFailed.make({ reason: "protocol_invalid" });
                completedTasks = frame.completed;
                onProgress?.(frame.completed, expected);
                break;
              case "result": {
                if (
                  frame.results.length !== expected ||
                  EffectArray.dedupe(frame.results.map((item) => item.id)).length !== expected
                )
                  return yield* EvaluationFailed.make({ reason: "evaluation_incomplete" });
                const scores = (domain: "coding" | "memory") =>
                  frame.results.filter((item) => item.domain === domain).map((item) => item.score);
                const codingScores = scores("coding");
                const memoryScores = scores("memory");
                if (codingScores.length !== expected / 2 || memoryScores.length !== expected / 2)
                  return yield* EvaluationFailed.make({ reason: "evaluation_incomplete" });
                const average = (values: readonly number[]) =>
                  values.reduce((sum, value) => sum + value, 0) / values.length;
                const coding = average(codingScores);
                const memory = average(memoryScores);
                state.result = {
                  score: (coding + memory) / 2,
                  coding,
                  memory,
                  tokens: totalTokens,
                };
                yield* Queue.end(input);
                break;
              }
              case "failure":
                // Accept only evaluator categories; arbitrary candidate text never becomes a reason.
                return yield* EvaluationFailed.make({
                  reason: Option.getOrElse(
                    Schema.decodeUnknownOption(WorkerFailureReason)(frame.reason),
                    () => "worker_failed" as const,
                  ),
                });
            }
          }),
        ),
        // The first expected failure is the evaluation's outcome; a broken stdout is a protocol
        // failure. Defects and interruptions stay in the fiber's exit.
        Effect.catch((error) =>
          Effect.gen(function* () {
            state.failure ??=
              error._tag === "EvaluationFailed"
                ? error
                : EvaluationFailed.make({ reason: "protocol_invalid" });
            yield* abortEffect;
          }),
        ),
        Effect.forkChild,
      );
      yield* child.stderr.pipe(
        Stream.runDrain,
        ignoreLogged("rrsi_stderr_drain_failed"),
        Effect.forkChild,
      );
      const code = yield* child.exitCode;
      yield* Fiber.join(requests);
      if (state.failure !== null) return yield* state.failure;
      if (code !== 0)
        return yield* EvaluationFailed.make({ reason: "evaluation_container_failed" });
      if (signal.aborted || state.result === null || modelCalls === 0 || totalTokens === 0)
        return yield* EvaluationFailed.make({ reason: "evaluation_incomplete" });
      return state.result;
    }).pipe(Effect.scoped),
  );
}

const Usage = Schema.Struct({
  usage: Schema.optionalKey(
    Schema.Struct({
      prompt_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      completion_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
});
export function reportedTokens(raw: string): number | null {
  // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
  const page = EffectFunction.flow(
    Schema.decodeResult(Schema.fromJsonString(Usage)),
    Result.getOrThrow,
  )(raw);
  return isTruthy(page.usage) ? page.usage.prompt_tokens + page.usage.completion_tokens : null;
}

const stringifyJson = <A>(value: A) =>
  Result.getOrThrow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown))(value));
