import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Cause, Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { memoryAgentLayer } from "../src/layers.ts";
import { HarnessStore } from "../src/rrsi/store.ts";
import { AgentChat } from "../src/agent/chat.ts";
import { Projects } from "../src/projects/projects.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { TurnSummaries } from "../src/agent/turn-summaries.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { createSubscriptionRuntime } from "../src/providers/subscription-runtime.ts";
import { WorkerGateway } from "../src/rrsi/worker-gateway.ts";
import { SubscriptionResult } from "../src/rrsi/model-gateway.ts";
import {
  OpenAICompatibleSettings,
  CompatibleFetch,
  CompatibleKeyring,
} from "../src/providers/openai-compatible.ts";
import { fakeEmbedderLayer } from "../src/testing/fake-embedder.ts";
import { fakeMorphLayer } from "../src/testing/fake-morph.ts";
import { readTrialAnswer } from "../src/rrsi/trial-response.ts";
import { EvaluationFailed } from "../src/rrsi/failure.ts";
import { corpus } from "./rrsi-corpus.ts";

class CodingVerificationFailed extends Schema.TaggedError<CodingVerificationFailed>()(
  "CodingVerificationFailed",
  {},
) {}

// Request metadata for direct AgentChat.handle calls; the worker has no HTTP server.
const inProcessChatUrl = "http://rrsi-worker.invalid/api/chat";
const emit = (
  value:
    | { kind: "request" | "subscription-request"; id: string; body: string }
    | { kind: "result"; results: { id: string; domain: string; score: number }[] }
    | { kind: "failure"; reason: string }
    | { kind: "progress"; completed: number; total: number },
) => process.stdout.write(`RRSI:${JSON.stringify(value)}\n`);
const gateway = ManagedRuntime.make(WorkerGateway.layer(process.stdin, emit));
const gatewayRequest = (
  kind: "request" | "subscription-request",
  body: string,
  signal?: AbortSignal | null,
) =>
  gateway.runPromise(
    Effect.flatMap(WorkerGateway, (service) => service.request(kind, body)),
    signal ? { signal } : undefined,
  );
const transport: typeof fetch = async (_url, init) => {
  const body = await gatewayRequest(
    "request",
    Schema.decodeUnknownSync(Schema.String)(init?.body),
    init?.signal,
  );
  const request = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ stream: Schema.optionalKey(Schema.Boolean) })),
  )(Schema.decodeUnknownSync(Schema.String)(init?.body));
  if (!request.stream)
    return new Response(body, { headers: { "content-type": "application/json" } });
  const page = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        id: Schema.String,
        model: Schema.String,
        choices: Schema.Array(
          Schema.Struct({
            message: Schema.Record(Schema.String, Schema.Unknown),
            finish_reason: Schema.String,
          }),
        ),
        usage: Schema.optionalKey(Schema.Unknown),
      }),
    ),
  )(body);
  const chunks = page.choices
    .map((choice, index) => {
      const delta = { ...choice.message };
      const calls = Schema.decodeUnknownOption(
        Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
      )(delta.tool_calls);
      if (calls._tag === "Some")
        delta.tool_calls = calls.value.map((call, i) => ({ ...call, index: i }));
      return `data: ${JSON.stringify({ id: page.id, object: "chat.completion.chunk", model: page.model, choices: [{ index, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: page.id, object: "chat.completion.chunk", model: page.model, choices: [{ index, delta: {}, finish_reason: choice.finish_reason }], usage: page.usage })}\n\n`;
    })
    .join("");
  return new Response(`${chunks}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
};

const filesystem = <A>(operation: () => A) =>
  Effect.try({
    try: operation,
    catch: () => new EvaluationFailed({ reason: "worker_failed" }),
  });
const evaluateWorker = Effect.fn("Rrsi.evaluateWorker")(function* () {
  const input = yield* (yield* WorkerGateway).input;
  const selection = {
    provider: input.provider ?? "openai-compatible",
    model: input.model,
    reasoningEffort: input.reasoningEffort ?? "default",
  };
  const results: { id: string; domain: string; score: number }[] = [];
  const tasks = input.split === "smoke" ? corpus("validation").slice(0, 2) : corpus(input.split);
  for (const task of tasks) {
    const root = yield* filesystem(() => mkdtempSync(join(tmpdir(), "rrsi-trial-")));
    const projectRoot = join(root, "project");
    const storage = join(root, "storage");
    const home = join(root, "home");
    yield* filesystem(() => {
      mkdirSync(join(projectRoot, "src"), { recursive: true });
      mkdirSync(storage);
      mkdirSync(home);
      if (task.fixture) writeFileSync(join(projectRoot, "src/solve.mjs"), task.fixture);
      writeFileSync(join(projectRoot, "notes.txt"), "Planning notes.\n".repeat(800));
      writeFileSync(
        join(storage, "config.json"),
        JSON.stringify({
          openaiCompatible: {
            baseUrl: "http://127.0.0.1/v1",
            model: input.model,
            contextWindow: 32000,
            outputBudget: 2048,
            toolCalling: true,
          },
          provider: selection.provider,
          model: input.model,
          reasoningEffort: selection.reasoningEffort,
        }),
      );
    });
    const compatibleLayer = OpenAICompatibleSettings.layerWith(
      Layer.succeed(CompatibleKeyring, { get: async () => null, set: async () => undefined }),
      Layer.succeed(CompatibleFetch, transport),
    );
    const registry = Layer.effect(
      ProviderRegistry,
      Effect.gen(function* () {
        const settings = yield* OpenAICompatibleSettings;
        const base = settings.services;
        const runtime =
          selection.provider === "openai-compatible"
            ? base.runtime
            : createSubscriptionRuntime(
                selection.provider,
                {
                  async *stream(body, signal) {
                    const result = Schema.decodeUnknownSync(
                      Schema.fromJsonString(SubscriptionResult),
                    )(await gatewayRequest("subscription-request", body, signal));
                    for (const event of result.events) yield event;
                  },
                },
                () => 32000,
              );
        const services = {
          ...base,
          provider: selection.provider,
          models: {
            ...base.models,
            provider: selection.provider,
            selected: Effect.succeed(selection),
          },
          runtime,
        };
        return {
          providers: [selection.provider],
          get: () => Effect.succeed(services),
          runtime: () => Effect.succeed(runtime),
        };
      }),
    ).pipe(Layer.provide(compatibleLayer));
    const trialLayer = memoryAgentLayer(storage, {
      providerRegistry: registry,
      compatibleSettings: compatibleLayer,
      embedder: fakeEmbedderLayer,
      morphAnalyzer: fakeMorphLayer,
      interpretAutomatically: false,
      importsWatching: false,
      importsHome: home,
      skillsHome: home,
      skillsBuiltin: join(home, "skills"),
      sweepSecrets: false,
    });
    const correct = yield* Effect.gen(function* () {
      const harness = yield* HarnessStore;
      yield* filesystem(() => harness.adopt(input.profile, harness.current().id));
      const projects = yield* Projects;
      const project = yield* projects.add(projectRoot);
      yield* projects.setPermissionMode(project.id, "full");
      const session = yield* (yield* Sessions).create(project.id);
      const agent = yield* AgentChat;
      const summaries = yield* TurnSummaries;
      let lastAnswer = "";
      for (const text of task.turns) {
        const response = yield* agent.handle(
          new Request(inProcessChatUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              threadId: session.id,
              tools: [],
              context: [],
              runId: randomUUID(),
              messages: [{ id: randomUUID(), role: "user", content: text }],
            }),
          }),
          session.id,
        );
        if (!response.ok) return yield* new EvaluationFailed({ reason: "trial_execution_failed" });
        const responseText = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: () => new EvaluationFailed({ reason: "trial_execution_failed" }),
        });
        lastAnswer = yield* readTrialAnswer(responseText);
        const summary = yield* summaries.catchUp(session.id, true);
        if (summary === "failed")
          return yield* new EvaluationFailed({ reason: "trial_execution_failed" });
      }
      let correct = false;
      if (task.domain === "coding") {
        correct = yield* Effect.try({
          try: () => {
            const result = execFileSync(
              process.execPath,
              [
                "--input-type=module",
                "-e",
                `import {solve} from './src/solve.mjs'; console.log(${task.verification});`,
              ],
              {
                cwd: projectRoot,
                timeout: 5000,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
              },
            ).trim();
            return (
              result === task.expected &&
              readFileSync(join(projectRoot, "src/solve.mjs"), "utf8") !== task.fixture
            );
          },
          catch: () => new CodingVerificationFailed(),
        }).pipe(Effect.catchTag("CodingVerificationFailed", () => Effect.succeed(false)));
      } else {
        correct =
          lastAnswer.includes(task.expected) &&
          !lastAnswer.includes("obsolete-") &&
          /[a-f0-9]{8}-[a-f0-9-]{27,}/i.test(lastAnswer);
      }
      return correct;
    }).pipe(Effect.provide(trialLayer));
    results.push({ id: task.id, domain: task.domain, score: correct ? 1 : 0 });
    emit({ kind: "progress", completed: results.length, total: tasks.length });
  }
  return results;
});

// The Node entry point and SDK transport are the only ManagedRuntime bridges.
try {
  await gateway.runPromise(
    evaluateWorker().pipe(
      Effect.matchCause({
        onSuccess: (results) => emit({ kind: "result", results }),
        onFailure: (cause) => {
          const error = Option.getOrUndefined(Cause.findErrorOption(cause));
          emit({
            kind: "failure",
            reason: error instanceof EvaluationFailed ? error.reason : "worker_failed",
          });
          process.exitCode = 1;
        },
      }),
    ),
  );
} finally {
  await gateway.dispose();
}
