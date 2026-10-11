import { nativePromise, runNativeEffect } from "../src/runtime/native-effect.ts";
import { nativeStream } from "../src/runtime/native-stream.ts";
import { Stream } from "effect";
import { Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../src/truthy.ts";
import { Predicate, Cause, Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { memoryAgentLayer } from "../src/layers.ts";
import { HarnessStore } from "../src/rrsi/store.ts";
import { AgentChat } from "../src/agent/chat.ts";
import { Projects } from "../src/projects/projects.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { TurnSummaries } from "../src/agent/turn-summaries.ts";
import {
  captureMemoryEvidence,
  evaluateMemoryAnswer,
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
import { corpus } from "./rrsi-corpus.ts";

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

const filesystem = <A>(operation: () => A) =>
  Effect.try({
    try: operation,
    catch: () => EvaluationFailed.make({ reason: "worker_failed" }),
  });
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
  const tasks = input.split === "smoke" ? corpus("validation").slice(0, 2) : corpus(input.split);
  for (const task of tasks) {
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "rrsi-trial-" });
    const projectRoot = path.join(root, "project");
    const storage = path.join(root, "storage");
    const home = path.join(root, "home");
    yield* fs.makeDirectory(path.join(projectRoot, "src"), { recursive: true });
    yield* fs.makeDirectory(storage);
    yield* fs.makeDirectory(home);
    if (isTruthy(task.fixture))
      yield* fs.writeFileString(path.join(projectRoot, "src/solve.mjs"), task.fixture);
    yield* fs.writeFileString(path.join(projectRoot, "notes.txt"), "Planning notes.\n".repeat(800));
    yield* fs.writeFileString(
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
      }),
    );
    const compatibleLayer = OpenAICompatibleSettings.layerWith(
      // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
      Layer.succeed(CompatibleKeyring, {
        get: () => Promise.resolve(null),
        set: () => Promise.resolve(undefined),
      }),
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
    const trialLayer = memoryAgentLayer(storage, {
      providerRegistry: registry,
      compatibleSettings: compatibleLayer,
      embedder: fakeEmbedderLayer,
      morphAnalyzer: fakeMorphLayer,
      interpretAutomatically: false,
      importsWatching: false,
      importsHome: home,
      skillsHome: home,
      skillsBuiltin: path.join(home, "skills"),
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
      const answers = yield* Effect.reduce(
        task.turns,
        (): TrialAnswers => ({ lastAnswer: "", correctionEvidence: Option.none() }),
        Effect.fnUntraced(function* (previous: TrialAnswers, text: string, turnIndex: number) {
          const response = yield* agent.handle(
            new Request(inProcessChatUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: stringifyJson({
                threadId: session.id,
                tools: [],
                context: [],
                runId: yield* crypto.randomUUIDv4(),
                messages: [{ id: yield* crypto.randomUUIDv4(), role: "user", content: text }],
              }),
            }),
            session.id,
          );
          if (!response.ok)
            return yield* EvaluationFailed.make({ reason: "trial_execution_failed" });
          const responseText = yield* Effect.tryPromise({
            try: () => response.text(),
            catch: () => EvaluationFailed.make({ reason: "trial_execution_failed" }),
          });
          const lastAnswer = yield* readTrialAnswer(responseText);
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
          const summary = yield* summaries.catchUp(session.id, true);
          if (summary === "failed")
            return yield* EvaluationFailed.make({ reason: "trial_execution_failed" });
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
          return yield* evaluateMemoryAnswer(answers.lastAnswer, answers.correctionEvidence.value);
        }
      }
      // Evaluation entry point owns this Layer and its resource scope.
    }).pipe(
      Effect.fnUntraced(function* <A, E, R>(program: Effect.Effect<A, E, R>) {
        const services = yield* Layer.build(trialLayer);
        return yield* Effect.provideContext(program, services);
      }, Effect.scoped),
    );
    results.push({ id: task.id, domain: task.domain, score: correct ? 1 : 0 });
    emit({ kind: "progress", completed: results.length, total: tasks.length });
  }
  return results;
});

// The Node entry point and SDK transport are the only ManagedRuntime bridges.
try {
  await gateway.runPromise(
    Effect.scoped(evaluateWorker()).pipe(
      Effect.matchCause({
        onSuccess: (results) => emit({ kind: "result", results }),
        onFailure: (cause) => {
          const error = Option.getOrUndefined(Cause.findErrorOption(cause));
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
