import { Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { randomUUID } from "node:crypto";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Option, Schema } from "effect";
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
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
export async function evaluateSandbox(
  client: ModelGateway,
  profile: HarnessProfile,
  split: "evolve" | "validation" | "sealed" | "smoke",
  signal: AbortSignal,
  consume: (raw: string) => void,
  image = "context-agent-rrsi:local",
  onProgress?: (completed: number, total: number) => void,
): Promise<Measurement> {
  const name = `rrsi-${randomUUID()}`;
  const child = spawn(
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
      "2g",
      "--cpus",
      "2",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=512m,mode=1777",
      "-e",
      "CONTEXT_AGENT_RRSI_WORKER=1",
      image,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let totalTokens: number | null = 0;
  let modelCalls = 0;
  let completedTasks = 0;
  const expected = split === "evolve" ? 12 : split === "smoke" ? 2 : 6;
  let result: Measurement | null = null;
  let failure: EvaluationFailed | null = null;
  const reads = createInterface({ input: child.stdout });
  const abort = () => {
    spawn("docker", ["kill", name], { stdio: "ignore" });
    child.kill("SIGTERM");
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  child.stdin.write(
    `${JSON.stringify({ kind: "initialize", profile, split, model: client.configuration.model, provider: client.configuration.provider, reasoningEffort: client.configuration.reasoningEffort })}\n`,
  );
  // Serialize requests at the host boundary. Candidate code has no network or credentials.
  let requests = Promise.resolve();
  reads.on("line", (line) => {
    if (!line.startsWith("RRSI:")) return;
    requests = requests
      // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
      .then(async () => {
        let frame: typeof Frame.Type;
        try {
          // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
          frame = EffectFunction.flow(
            Schema.decodeResult(Schema.fromJsonString(Frame)),
            Result.getOrThrow,
          )(line.slice(5));
        } catch {
          throw EvaluationFailed.make({ reason: "protocol_invalid" });
        }
        switch (frame.kind) {
          case "request":
          case "subscription-request": {
            if (frame.kind === "subscription-request" && client.protocol !== "subscription")
              throw EvaluationFailed.make({ reason: "gateway_protocol_mismatch" });
            let raw: string;
            try {
              raw =
                frame.kind === "subscription-request" && client.protocol === "subscription"
                  ? await client.subscription(frame.body, signal)
                  : await client.complete(frame.body, signal);
            } catch (error) {
              throw EvaluationFailed.make({
                reason:
                  error instanceof CompatibleCompletionRejected &&
                  error.reason === "memory_capacity_exceeded"
                    ? "gateway_memory_limit"
                    : "gateway_request_failed",
              });
            }
            modelCalls++;
            consume(raw);
            const usage = reportedTokens(raw);
            totalTokens = totalTokens === null || usage === null ? null : totalTokens + usage;
            child.stdin.write(
              `${JSON.stringify({ kind: "response", id: frame.id, ok: true, body: raw })}\n`,
            );
            break;
          }
          case "progress":
            if (
              frame.total !== expected ||
              frame.completed > expected ||
              frame.completed < completedTasks
            )
              throw EvaluationFailed.make({ reason: "protocol_invalid" });
            completedTasks = frame.completed;
            onProgress?.(frame.completed, expected);
            break;
          case "result": {
            if (
              frame.results.length !== expected ||
              new Set(frame.results.map((item) => item.id)).size !== expected
            )
              throw EvaluationFailed.make({ reason: "evaluation_incomplete" });
            const score = (domain: "coding" | "memory") => {
              const items = frame.results.filter((item) => item.domain === domain);
              if (items.length !== expected / 2)
                throw EvaluationFailed.make({ reason: "evaluation_incomplete" });
              return items.reduce((sum, item) => sum + item.score, 0) / items.length;
            };
            const coding = score("coding");
            const memory = score("memory");
            result = { score: (coding + memory) / 2, coding, memory, tokens: totalTokens };
            child.stdin.end();
            break;
          }
          case "failure":
            // Accept only evaluator categories; arbitrary candidate text never becomes a reason.
            throw EvaluationFailed.make({
              reason: Option.getOrElse(
                Schema.decodeUnknownOption(WorkerFailureReason)(frame.reason),
                () => "worker_failed" as const,
              ),
            });
        }
      })
      .catch((error: Error) => {
        failure ??= Schema.is(EvaluationFailed)(error)
          ? error
          : EvaluationFailed.make({
              reason: "protocol_invalid",
            });
        abort();
      });
  });
  // Do not echo candidate stderr, which may contain arbitrary workspace or request text.
  child.stderr.resume();
  try {
    // Callback-to-Promise handshake for the native caller; cleanup stays at this protocol boundary.
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    await requests;
    if (failure !== null) throw failure;
    if (code !== 0) throw EvaluationFailed.make({ reason: "evaluation_container_failed" });
    if (signal.aborted || result === null || modelCalls === 0 || totalTokens === 0)
      throw EvaluationFailed.make({ reason: "evaluation_incomplete" });
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
    reads.close();
    if (child.exitCode === null) abort();
  }
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
