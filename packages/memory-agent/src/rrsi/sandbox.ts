import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Schema } from "effect";
import type { ModelGateway } from "./model-gateway.ts";
import type { HarnessProfile, Measurement } from "./contracts.ts";

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
]);
export async function evaluateSandbox(
  client: ModelGateway,
  profile: HarnessProfile,
  split: "evolve" | "validation" | "sealed" | "smoke",
  signal: AbortSignal,
  consume: (raw: string) => void,
  image = "context-agent-rrsi:local",
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
  let result: Measurement | null = null;
  let protocolFailed = false;
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
      .then(async () => {
        const frame = Schema.decodeUnknownSync(Schema.fromJsonString(Frame))(line.slice(5));
        switch (frame.kind) {
          case "request":
          case "subscription-request": {
            if (frame.kind === "subscription-request" && client.protocol !== "subscription")
              throw new Error("gateway_protocol_mismatch");
            const raw =
              frame.kind === "subscription-request" && client.protocol === "subscription"
                ? await client.subscription(frame.body, signal)
                : await client.complete(frame.body, signal);
            modelCalls++;
            consume(raw);
            const usage = reportedTokens(raw);
            totalTokens = totalTokens === null || usage === null ? null : totalTokens + usage;
            child.stdin.write(
              `${JSON.stringify({ kind: "response", id: frame.id, ok: true, body: raw })}\n`,
            );
            break;
          }
          case "result": {
            const expected = split === "evolve" ? 12 : split === "smoke" ? 2 : 6;
            if (
              frame.results.length !== expected ||
              new Set(frame.results.map((item) => item.id)).size !== expected
            )
              throw new Error("incomplete_evaluation");
            const score = (domain: "coding" | "memory") => {
              const items = frame.results.filter((item) => item.domain === domain);
              if (items.length !== expected / 2) throw new Error("incomplete_domain");
              return items.reduce((sum, item) => sum + item.score, 0) / items.length;
            };
            const coding = score("coding");
            const memory = score("memory");
            result = { score: (coding + memory) / 2, coding, memory, tokens: totalTokens };
            child.stdin.end();
            break;
          }
          case "failure":
            throw new Error(frame.reason);
        }
      })
      .catch(() => {
        protocolFailed = true;
        abort();
      });
  });
  // Do not echo candidate stderr, which may contain arbitrary workspace or request text.
  child.stderr.resume();
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? resolve() : reject(new Error("evaluation_container_failed")),
      );
    });
    await requests;
    if (
      signal.aborted ||
      protocolFailed ||
      result === null ||
      modelCalls === 0 ||
      totalTokens === 0
    )
      throw new Error("evaluation_incomplete");
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
  const page = Schema.decodeUnknownSync(Schema.fromJsonString(Usage))(raw);
  return page.usage ? page.usage.prompt_tokens + page.usage.completion_tokens : null;
}
