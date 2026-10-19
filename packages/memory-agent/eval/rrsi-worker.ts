import { nativePromise, runNativeEffect } from "../src/runtime/native-effect.ts";
import { nativeStream } from "../src/runtime/native-stream.ts";
import { Stream } from "effect";
import { Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../src/truthy.ts";
import { Predicate, Cause, Config, Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { memoryAgentLayer } from "../src/layers.ts";
import { HarnessStore } from "../src/rrsi/store.ts";
import { AgentChat } from "../src/agent/chat.ts";
import { Projects } from "../src/projects/projects.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { TurnSummaries } from "../src/agent/turn-summaries.ts";
import {
  captureMemoryEvidence,
  evaluateMemoryAnswer,
  evaluateUsageAnswer,
  type MemoryEvidence,
} from "../src/rrsi/memory-score.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { createSubscriptionRuntime } from "../src/providers/subscription-runtime.ts";
import { WorkerGateway, GatewayClosed } from "../src/rrsi/worker-gateway.ts";
import { NodeStream, NodeServices } from "@effect/platform-node";
import { Crypto, FileSystem, Path } from "effect";
import { runProcess } from "../src/rrsi/command.ts";
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
import { corpus, type EvalTask } from "./rrsi-corpus.ts";
import { UsageCorpus, usageQuestion, type UsageTask } from "../src/rrsi/usage-corpus.ts";
import { SqlClient } from "effect/sql";

interface TrialAnswers {
  readonly lastAnswer: string;
  readonly correctionEvidence: Option.Option<MemoryEvidence>;
}

// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const stringifyJson = EffectFunction.flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);

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
) => process.stdout.write(`RRSI:${stringifyJson(value)}\n`);
const gateway = ManagedRuntime.make(
  Layer.merge(
    NodeServices.layer,
    WorkerGateway.layer(
      NodeStream.fromReadable({
        evaluate: () => process.stdin,
        onError: () => GatewayClosed.make(),
      }),
      emit,
    ),
  ),
);
const gatewayRequest = (
  kind: "request" | "subscription-request",
  body: string,
  signal?: AbortSignal | null,
) =>
  gateway.runPromise(
    Effect.flatMap(WorkerGateway, (service) => service.request(kind, body)),
    Predicate.isNotNullish(signal) ? { signal } : undefined,
  );
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
const transport: typeof fetch = (_url, init) =>
  runNativeEffect(
    Effect.gen(function* () {
      const body = yield* nativePromise(() =>
        gatewayRequest(
          "request",
          // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
          EffectFunction.flow(
            Schema.decodeUnknownResult(Schema.String),
            Result.getOrThrow,
          )(init?.body),
          init?.signal,
        ),
      );
      // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
      const request = EffectFunction.flow(
        Schema.decodeResult(
          Schema.fromJsonString(Schema.Struct({ stream: Schema.optionalKey(Schema.Boolean) })),
        ),
        Result.getOrThrow,
      )(
        EffectFunction.flow(
          Schema.decodeUnknownResult(Schema.String),
          Result.getOrThrow,
        )(init?.body),
      );
      if (!isTruthy(request.stream))
        return new Response(body, { headers: { "content-type": "application/json" } });
      // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
      const page = EffectFunction.flow(
        Schema.decodeResult(
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
        ),
        Result.getOrThrow,
      )(body);
      const chunks = page.choices
        .map((choice, index) => {
          const delta = { ...choice.message };
          const calls = Schema.decodeUnknownOption(
            Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
          )(delta.tool_calls);
          if (calls._tag === "Some")
            delta.tool_calls = calls.value.map((call, i) => ({ ...call, index: i }));
          return `data: ${stringifyJson({ id: page.id, object: "chat.completion.chunk", model: page.model, choices: [{ index, delta, finish_reason: null }] })}\n\ndata: ${stringifyJson({ id: page.id, object: "chat.completion.chunk", model: page.model, choices: [{ index, delta: {}, finish_reason: choice.finish_reason }], usage: page.usage })}\n\n`;
        })
        .join("");
      return new Response(`${chunks}data: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }),
  );

// The container's writable volume; the read-only root has no other room for a storage copy.
const workRoot = "/work";

type WorkerTask =
  | { readonly kind: "synthetic"; readonly task: EvalTask }
  | { readonly kind: "usage"; readonly task: UsageTask };

const evaluateWorker = Effect.fn("Rrsi.evaluateWorker")(function* () {
  const input = yield* (yield* WorkerGateway).input;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const selection = {
    provider: input.provider ?? "openai-compatible",
    model: input.model,
    reasoningEffort: input.reasoningEffort ?? "default",
  };
  const results: { id: string; domain: string; score: number }[] = [];
  const synthetic =
    input.split === "smoke" ? corpus("validation").slice(0, 2) : corpus(input.split);
  const usageRoot = Option.getOrNull(
    yield* Config.String("CONTEXT_AGENT_RRSI_USAGE").pipe(Config.option),
  );
  const usage =
    usageRoot === null
      ? null
      : yield* fs
          .readFileString(path.join(usageRoot, "corpus.json"))
          .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(UsageCorpus))));
  // Real corrections replace the synthetic memory tasks, keeping the per-suite count the host expects.
  const tasks: WorkerTask[] =
    usage === null
      ? synthetic.map((task) => ({ kind: "synthetic", task }))
      : [
          ...synthetic
            .filter((task) => task.domain === "coding")
            .map((task): WorkerTask => ({ kind: "synthetic", task })),
          ...usage.tasks
            .filter((task) => task.split === (input.split === "smoke" ? "validation" : input.split))
            .slice(0, synthetic.filter((task) => task.domain === "memory").length)
            .map((task): WorkerTask => ({ kind: "usage", task })),
        ];
  const writeConfig = (storage: string, extra: { readonly embeddingDevice?: "gpu" }) =>
    fs.writeFileString(
      path.join(storage, "config.json"),
      stringifyJson({
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
        ...extra,
      }),
    );
  const compatibleLayer = OpenAICompatibleSettings.layerWith(
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    Layer.succeed(CompatibleKeyring, () => ({
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(undefined),
    })),
    Layer.succeed(CompatibleFetch, transport),
  );
  const registry = Layer.effect(
    ProviderRegistry,
    Effect.gen(function* () {
      const settings = yield* OpenAICompatibleSettings;
      const base = settings.services;
      const runtime =
        selection.provider === "openai-compatible"
          ? yield* settings.runtime.pipe(Effect.orDie)
          : createSubscriptionRuntime(
              selection.provider,
              {
                // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
                stream: (body, signal) =>
                  nativeStream(
                    Stream.fromEffect(
                      nativePromise(() =>
                        gatewayRequest("subscription-request", body, signal),
                      ).pipe(
                        Effect.flatMap(
                          Schema.decodeEffect(Schema.fromJsonString(SubscriptionResult)),
                        ),
                      ),
                    ).pipe(Stream.flatMap((result) => Stream.fromIterable(result.events))),
                  ),
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
  const agentLayer = (
    storage: string,
    home: string,
    models: Pick<Parameters<typeof memoryAgentLayer>[1] & object, "embedder" | "morphAnalyzer">,
  ) =>
    memoryAgentLayer(storage, {
      providerRegistry: registry,
      compatibleSettings: compatibleLayer,
      ...models,
      interpretAutomatically: false,
      importsWatching: false,
      importsHome: home,
      skillsHome: home,
      skillsBuiltin: path.join(home, "skills"),
      sweepSecrets: false,
    });
  /** Sends one user turn in a session and returns the final answer text. */
  const ask = Effect.fnUntraced(function* (sessionId: string, text: string) {
    const agent = yield* AgentChat;
    const response = yield* agent.handle(
      new Request(inProcessChatUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: stringifyJson({
          threadId: sessionId,
          tools: [],
          context: [],
          runId: yield* crypto.randomUUIDv4(),
          messages: [{ id: yield* crypto.randomUUIDv4(), role: "user", content: text }],
        }),
      }),
      sessionId,
    );
    if (!response.ok) return yield* EvaluationFailed.make({ reason: "trial_execution_failed" });
    const responseText = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => EvaluationFailed.make({ reason: "trial_execution_failed" }),
    });
    const answer = yield* readTrialAnswer(responseText);
    const summary = yield* (yield* TurnSummaries).catchUp(sessionId, true);
    if (summary === "failed")
      return yield* EvaluationFailed.make({ reason: "trial_execution_failed" });
    return answer;
  });

  // One writable copy of the snapshot serves every usage task; each asks in a new session.
  const usageServices =
    usageRoot === null
      ? null
      : yield* Effect.gen(function* () {
          const storage = path.join(workRoot, "storage");
          const home = path.join(workRoot, "home");
          yield* fs.remove(storage, { recursive: true, force: true });
          yield* fs.makeDirectory(storage, { recursive: true });
          yield* fs.makeDirectory(home, { recursive: true });
          yield* fs.copyFile(path.join(usageRoot, "agent.db"), path.join(storage, "agent.db"));
          yield* fs.copy(path.join(usageRoot, "vectors"), path.join(storage, "vectors"));
          yield* fs.symlink("/models", path.join(storage, "models"));
          // The snapshot's vectors are the GPU mode's fp32 model. Without WebGPU that mode runs the
          // same model on the CPU; the CPU mode's quantized model would re-embed the whole snapshot.
          yield* writeConfig(storage, { embeddingDevice: "gpu" });
          const services = yield* Layer.build(agentLayer(storage, home, {}));
          yield* Effect.gen(function* () {
            const harness = yield* HarnessStore;
            yield* harness.adopt(input.profile, (yield* harness.current).id);
            // Real project roots do not exist here; tools work in empty stand-ins, without approval.
            const sql = yield* SqlClient.SqlClient;
            const projects = yield* sql<{ id: string }>`SELECT id FROM projects`;
            yield* Effect.forEach(projects, (project) =>
              fs.makeDirectory(path.join(workRoot, "projects", project.id), { recursive: true }),
            );
            yield* sql`UPDATE projects SET root = ${path.join(workRoot, "projects")} || '/' || id, permission_full = 1`;
          }).pipe(Effect.provideContext(services));
          return services;
        });

  for (const entry of tasks) {
    const correct = yield* Effect.gen(function* () {
      switch (entry.kind) {
        case "usage": {
          if (usageServices === null)
            return yield* EvaluationFailed.make({ reason: "evaluation_incomplete" });
          const task = entry.task;
          return yield* Effect.gen(function* () {
            const session = yield* (yield* Sessions).create(task.projectId);
            const answer = yield* ask(session.id, usageQuestion(task));
            return yield* evaluateUsageAnswer(answer, task.correctionNodeId);
          }).pipe(Effect.provideContext(usageServices));
        }
        case "synthetic":
          return yield* syntheticTrial(entry.task);
      }
    });
    results.push({
      id: entry.task.id,
      domain: entry.kind === "usage" ? "memory" : entry.task.domain,
      score: correct ? 1 : 0,
    });
    emit({ kind: "progress", completed: results.length, total: tasks.length });
  }
  if (usageServices !== null) {
    // Tearing down the real embedding and morphology workers can abort the process (an uncaught
    // Napi::Error, exit 133) before the result is sent. The container is discarded after one run,
    // so report and exit without that teardown.
    emit({ kind: "result", results });
    return yield* Effect.sync(() => process.exit(0));
  }
  return results;

  function syntheticTrial(task: EvalTask) {
    return Effect.gen(function* () {
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "rrsi-trial-" });
      const projectRoot = path.join(root, "project");
      const storage = path.join(root, "storage");
      const home = path.join(root, "home");
      yield* fs.makeDirectory(path.join(projectRoot, "src"), { recursive: true });
      yield* fs.makeDirectory(storage);
      yield* fs.makeDirectory(home);
      if (isTruthy(task.fixture))
        yield* fs.writeFileString(path.join(projectRoot, "src/solve.mjs"), task.fixture);
      yield* fs.writeFileString(
        path.join(projectRoot, "notes.txt"),
        "Planning notes.\n".repeat(800),
      );
      yield* writeConfig(storage, {});
      const trialLayer = agentLayer(storage, home, {
        embedder: fakeEmbedderLayer,
        morphAnalyzer: fakeMorphLayer,
      });
      return yield* Effect.gen(function* () {
        const harness = yield* HarnessStore;
        yield* harness.adopt(input.profile, (yield* harness.current).id);
        const projects = yield* Projects;
        const project = yield* projects.add(projectRoot);
        yield* projects.setPermissionMode(project.id, "full");
        const session = yield* (yield* Sessions).create(project.id);
        const answers = yield* Effect.reduce(
          task.turns,
          (): TrialAnswers => ({ lastAnswer: "", correctionEvidence: Option.none() }),
          Effect.fnUntraced(function* (previous: TrialAnswers, text: string, turnIndex: number) {
            const lastAnswer = yield* ask(session.id, text);
            let correctionEvidence = previous.correctionEvidence;
            switch (task.domain) {
              case "memory": {
                if (turnIndex === task.correctionTurnIndex) {
                  correctionEvidence = Option.some(
                    yield* captureMemoryEvidence({
                      projectId: project.id,
                      sessionId: session.id,
                      text,
                      decision: task.expected,
                    }),
                  );
                }
                break;
              }
              case "coding":
                break;
            }
            return { lastAnswer, correctionEvidence };
          }),
        );
        switch (task.domain) {
          case "coding": {
            return yield* Effect.gen(function* () {
              const execution = yield* nativePromise(() =>
                runProcess({
                  command: process.execPath,
                  args: [
                    "--input-type=module",
                    "-e",
                    `import {solve} from './src/solve.mjs'; console.log(${task.verification});`,
                  ],
                  cwd: projectRoot,
                  timeout: 5000,
                }),
              );
              const source = yield* fs.readFileString(path.join(projectRoot, "src/solve.mjs"));
              return execution.stdout.trim() === task.expected && source !== task.fixture;
            }).pipe(
              Effect.mapError(() => CodingVerificationFailed.make()),
              Effect.catchTag("CodingVerificationFailed", () => Effect.succeed(false)),
            );
          }
          case "memory": {
            if (Option.isNone(answers.correctionEvidence)) {
              return yield* EvaluationFailed.make({ reason: "evaluation_incomplete" });
            }
            return yield* evaluateMemoryAnswer(
              answers.lastAnswer,
              answers.correctionEvidence.value,
            );
          }
        }
        // Evaluation entry point owns this Layer and its resource scope.
      }).pipe(
        Effect.fnUntraced(function* <A, E, R>(program: Effect.Effect<A, E, R>) {
          const services = yield* Layer.build(trialLayer);
          return yield* Effect.provideContext(program, services);
        }, Effect.scoped),
      );
    }).pipe(Effect.scoped);
  }
});

// The Node entry point and SDK transport are the only ManagedRuntime bridges.
try {
  await gateway.runPromise(
    Effect.scoped(evaluateWorker()).pipe(
      Effect.matchCause({
        onSuccess: (results) => emit({ kind: "result", results }),
        onFailure: (cause) => {
          const error = Option.getOrUndefined(Cause.findErrorOption(cause));
          // The frame carries only a category; the sandbox's stderr keeps the cause for diagnosis.
          process.stderr.write(`${Cause.pretty(cause)}\n`);
          emit({
            kind: "failure",
            reason: Schema.is(EvaluationFailed)(error) ? error.reason : "worker_failed",
          });
          process.exitCode = 1;
        },
      }),
    ),
  );
} finally {
  await gateway.dispose();
}
