import {
  Array,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Schema,
  Scope,
} from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import { Rrsi, RrsiExecution } from "../src/rrsi/service.ts";
import { HarnessStore } from "../src/rrsi/store.ts";
import { Database } from "../src/db/database.ts";
import { GlobalConfig } from "../src/config/global-config.ts";
import { StorageRoot } from "../src/config/storage-root.ts";
import {
  OpenAICompatibleSettings,
  CompatibleFetch,
  CompatibleKeyring,
} from "../src/providers/openai-compatible.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const fixture = Effect.fnUntraced(function* (options: {
  readonly reject?: boolean;
  readonly zeroMemory?: boolean;
  readonly hold?: (
    signal: AbortSignal,
  ) => Promise<{ score: number; coding: number; memory: number; tokens: number }>;
}) {
  vi.stubEnv("CONTEXT_AGENT_RRSI_REPOSITORY", "");
  vi.stubEnv("CONTEXT_AGENT_RRSI_ORIGINAL_STORAGE", "");
  vi.stubEnv("CONTEXT_AGENT_RRSI_WORKER", "1");
  const fs = Context.get(yield* Layer.build(NodeFileSystem.layer), FileSystem.FileSystem);
  const directory = yield* fs.makeTempDirectoryScoped();
  const owner = yield* Scope.fork(yield* Effect.scope);
  const state = { released: 0, splits: Array.empty<string>() };
  const runEffect = Effect.runPromiseWith(yield* Effect.context());
  const usage = { prompt_tokens: 10, completion_tokens: 1 };
  const encodedUsage = yield* encodeJson({ usage });
  const proposal = yield* encodeJson({
    profile: {
      rolePrompt: "",
      memoryToolDescription: "",
      retrievalLeadLimit: 5,
      retrievalTokenLimit: 400,
    },
    edits: [
      { component: "memory", hypothesis: "Keep the same quality with less retrieved context." },
    ],
  });
  const approved = yield* encodeJson({ approved: true });
  const proposalResponse = yield* encodeJson({
    choices: [{ message: { content: proposal } }],
    usage,
  });
  const approvalResponse = yield* encodeJson({
    choices: [{ message: { content: approved } }],
    usage,
  });
  const native = Layer.succeed(RrsiExecution, {
    image: Effect.succeed(`sha256:${"0".repeat(64)}`),
    pinModel: () =>
      Effect.succeed({
        protocol: "chat-completions",
        configuration: {
          provider: "openai-compatible",
          model: "fixture",
          baseUrl: "fixture",
          reasoningEffort: "default",
        },
        release: () => {
          state.released++;
        },
        complete: (body, signal) =>
          runEffect(
            Effect.succeed(
              body.includes("Propose one reusable") ? proposalResponse : approvalResponse,
            ),
            { signal },
          ),
      }),
    evaluate: (_client, profile, split, signal, consume, _image, progress) => {
      if (options.hold !== undefined) return options.hold(signal);
      return runEffect(
        Effect.sync(() => {
          state.splits.push(split);
          consume(encodedUsage);
          progress?.(split === "evolve" ? 12 : 6, split === "evolve" ? 12 : 6);
          const improved = profile.retrievalTokenLimit === 400;
          const regression = options.reject === true && split === "validation" && improved;
          const memory = regression || (options.zeroMemory === true && !improved) ? 0 : 0.5;
          const coding = regression ? 1 : 0.5;
          return { score: (coding + memory) / 2, coding, memory, tokens: improved ? 80 : 100 };
        }),
        { signal },
      );
    },
  });
  const config = GlobalConfig.layer.pipe(Layer.provide(StorageRoot.layer(directory)));
  const compatible = OpenAICompatibleSettings.layerWith(
    Layer.succeed(CompatibleKeyring, {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
    }),
    Layer.succeed(CompatibleFetch, () => Promise.resolve(Response.json({}))),
  ).pipe(Layer.provide(config));
  const dependencies = Layer.mergeAll(
    Database.layer(":memory:"),
    config,
    compatible,
    ProviderRegistry.layer([]),
  );
  const context = yield* Layer.build(
    Rrsi.layerWith(native).pipe(
      Layer.provideMerge(HarnessStore.layer.pipe(Layer.provideMerge(dependencies))),
    ),
  ).pipe(Effect.provideService(Scope.Scope, owner));
  const service = Context.get(context, Rrsi);
  const store = Context.get(context, HarnessStore);
  store.configure({ enabled: false, maxMinutes: 1 });
  return {
    owner,
    service,
    store,
    state,
    start: service.start().pipe(Effect.provideContext(context)),
  };
});

afterEach(() => vi.unstubAllEnvs());

it.live.each(["manual", "shutdown"] as const)(
  "%s waits for evaluator cleanup before releasing the model",
  (mode) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const closing = yield* Deferred.make<void>();
      const allowClose = yield* Deferred.make<void>();
      const runEffect = Effect.runPromiseWith(yield* Effect.context());
      const { owner, service, store, state, start } = yield* fixture({
        hold: (signal) =>
          runEffect(
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Deferred.succeed(closing, undefined).pipe(
                  Effect.andThen(Deferred.await(allowClose)),
                ),
              ),
            ),
            { signal },
          ),
      });
      yield* start;
      yield* Deferred.await(started);
      const stopping = yield* Effect.forkScoped(
        mode === "manual" ? service.stop : Scope.close(owner, Exit.void),
      );
      yield* Deferred.await(closing);
      expect(state.released).toBe(0);
      yield* Deferred.succeed(allowClose, undefined);
      yield* Fiber.join(stopping);
      expect(state.released).toBe(1);
      if (mode === "manual") {
        expect(store.experiments()[0]).toMatchObject({
          status: "cancelled",
          reason: "manual_stop",
        });
        expect((yield* service.status).running).toBe(false);
      }
    }),
);

it.live.each([
  { reject: false, zeroMemory: false },
  { reject: true, zeroMemory: false },
  { reject: false, zeroMemory: true },
])(
  "evaluation reaches selection and independent validation ($reject, zero-memory=$zeroMemory)",
  (options) =>
    Effect.gen(function* () {
      const { service, store, state, start } = yield* fixture(options);
      const originalGoal = store.forGoal("existing");
      yield* start;
      yield* Effect.repeat(service.status, { until: (status) => !status.running });
      const record = store.experiments()[0];
      expect(record.status).toBe("completed");
      expect(record.baselines).toHaveLength(3);
      expect(record.candidates.some((candidate) => candidate.decision === "round_winner")).toBe(
        true,
      );
      expect(state.splits).toContain("validation");
      expect(store.forGoal("existing").id).toBe(originalGoal.id);
      expect(state.released).toBe(1);
      if (options.reject) {
        expect(record.reason).toBe("validation_rejected");
        expect(state.splits).not.toContain("sealed");
        expect(store.current().id).toBe("baseline");
        expect(record.adoptedVersionId).toBeUndefined();
      } else {
        expect(record.reason).toBe("profile_adopted");
        expect(state.splits).toContain("sealed");
        expect(store.current().profile.retrievalTokenLimit).toBe(400);
        expect(store.forGoal("new").id).toBe(record.adoptedVersionId);
        expect(yield* Effect.flip(start)).toMatchObject({
          _tag: "RrsiFailed",
          reason: "sealed_corpus_exhausted",
        });
      }
    }),
);
