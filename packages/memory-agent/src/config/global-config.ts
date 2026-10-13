import { isTruthy } from "../truthy.ts";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { Context, Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect";
import { ProviderId } from "../providers/contracts.ts";
import { OpenAICompatibleConfiguration } from "../providers/openai-compatible-config.ts";
import { StorageRoot } from "./storage-root.ts";

/**
 * How the embedding model runs. `auto` picks `gpu` on a machine with enough memory where WebGPU
 * was found to work, and `cpu` otherwise.
 */
export const EmbeddingChoice = Schema.Literals(["auto", "cpu", "gpu"]);
export type EmbeddingChoice = typeof EmbeddingChoice.Type;

/** Whether the full-precision model ran on WebGPU when this machine was last checked. */
export const GpuCheck = Schema.Union([
  Schema.Struct({ status: Schema.Literal("available"), checkedAt: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    checkedAt: Schema.String,
    reason: Schema.String,
  }),
]);
export type GpuCheck = typeof GpuCheck.Type;

/** Persisted, versioned policy for model-dependent capabilities. Missing entries deny access. */
export const ModelFeatureFlagSettings = Schema.Struct({
  version: Schema.Literal(1),
  global: Schema.Boolean,
  providers: Schema.Record(Schema.String, Schema.Boolean),
  capabilities: Schema.Record(Schema.String, Schema.Boolean),
  models: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Boolean)),
  routes: Schema.Record(Schema.String, Schema.Boolean),
});
export type ModelFeatureFlagSettings = typeof ModelFeatureFlagSettings.Type;

export const CrossProviderMediaConsentMode = Schema.Literals(["disabled", "ask", "always"]);
export type CrossProviderMediaConsentMode = typeof CrossProviderMediaConsentMode.Type;
/** Explicit provider-pair consent. Login or entitlement never creates an entry automatically. */
export const CrossProviderMediaConsentSettings = Schema.Struct({
  version: Schema.Literal(1),
  pairs: Schema.Record(Schema.String, CrossProviderMediaConsentMode),
});
export type CrossProviderMediaConsentSettings = typeof CrossProviderMediaConsentSettings.Type;

/**
 * Percent of the context window a conversation fills before its turns are summarized; 0 summarizes
 * from the start. It stays below the share where the oldest messages are left out (55%), so the
 * summaries are ready before anything has to go.
 */
export const SummaryStartPercent = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50 }));

/** User-wide settings. Secrets never go here; they belong in the OS keychain. */
export const Settings = Schema.Struct({
  openaiCompatible: Schema.optional(OpenAICompatibleConfiguration),
  /** Provider paired with the selected model. Legacy model-only settings migrate to OpenAI. */
  provider: Schema.optional(ProviderId),
  /** Model id chosen from the signed-in provider's model list. */
  model: Schema.optional(Schema.String),
  /** One of the efforts that model advertises, e.g. "low" or "high". */
  reasoningEffort: Schema.optional(Schema.NonEmptyString),
  /** The user turned Kagi Search and Extract on. The key itself is in the keychain. */
  kagiEnabled: Schema.optional(Schema.Boolean),
  /** Keep migrating other coding agents' transcripts as they grow. Default off until turned on. */
  importsEnabled: Schema.optional(Schema.Boolean),
  /** Interpret migrated statements for topics and corrections, like the ones said here. */
  importsInterpret: Schema.optional(Schema.Boolean),
  /** User explicitly enabled image generation. Defaults off when absent. */
  imageGenerationEnabled: Schema.optional(Schema.Boolean),
  /** Staged Work Trace UI/API exposure. Instrumentation and migrations stay on to avoid data loss. */
  workTraceEnabled: Schema.optional(Schema.Boolean),
  /** Server-authoritative flags for every model-dependent capability. */
  modelFeatureFlags: Schema.optional(ModelFeatureFlagSettings),
  /** Explicit consent for sending a media request from one provider to another. */
  crossProviderMediaConsent: Schema.optional(CrossProviderMediaConsentSettings),
  /** Takes effect when the app next starts; `auto` when unset. */
  embeddingDevice: Schema.optional(EmbeddingChoice),
  gpuCheck: Schema.optional(GpuCheck),
  /** `defaultSummaryStartPercent` when unset. */
  summaryStartPercent: Schema.optional(SummaryStartPercent),
});
export type Settings = typeof Settings.Type;

export class GlobalConfigFailed extends Schema.TaggedError<GlobalConfigFailed>()(
  "GlobalConfigFailed",
  {
    operation: Schema.Literals(["read", "write"]),
    reason: Schema.Union([
      Schema.TaggedStruct("MissingFile", {}),
      Schema.TaggedStruct("ReadFailed", {}),
      Schema.TaggedStruct("WriteFailed", {}),
      Schema.TaggedStruct("InvalidSettings", {}),
    ]),
    cause: Schema.Defect(),
  },
) {}

const make = Effect.gen(function* () {
  const storage = yield* StorageRoot;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(storage.path, "config.json");

  const updates = Semaphore.makeUnsafe(1);
  const jsonSettings = Schema.fromJsonString(Settings, { space: 2 });
  const write = (settings: Settings) =>
    Effect.gen(function* () {
      const json = yield* Schema.encodeEffect(jsonSettings)(settings).pipe(
        Effect.mapError((cause) =>
          GlobalConfigFailed.make({
            operation: "write",
            reason: { _tag: "InvalidSettings" },
            cause,
          }),
        ),
      );
      const temporary = `${file}.${process.pid}.tmp`;
      yield* Effect.acquireUseRelease(
        fs.makeDirectory(storage.path, { recursive: true, mode: 0o700 }),
        () =>
          fs
            .writeFileString(temporary, `${json}\n`, { mode: 0o600 })
            .pipe(Effect.andThen(fs.rename(temporary, file))),
        () => fs.remove(temporary, { force: true }),
      ).pipe(
        Effect.uninterruptible,
        Effect.mapError((cause) =>
          GlobalConfigFailed.make({ operation: "write", reason: { _tag: "WriteFailed" }, cause }),
        ),
      );
      return settings;
    });
  const read = Effect.gen(function* () {
    const json = yield* fs.readFileString(file).pipe(
      Effect.mapError((cause) =>
        GlobalConfigFailed.make({
          operation: "read",
          reason:
            cause.reason._tag === "NotFound" ? { _tag: "MissingFile" } : { _tag: "ReadFailed" },
          cause,
        }),
      ),
      Effect.catchReason("GlobalConfigFailed", "MissingFile", () => Effect.succeed(null)),
    );
    if (json === null) return {};
    const settings = yield* Schema.decodeEffect(jsonSettings)(json).pipe(
      Effect.mapError((cause) =>
        GlobalConfigFailed.make({ operation: "read", reason: { _tag: "InvalidSettings" }, cause }),
      ),
    );
    if (
      isTruthy(settings.model) &&
      isTruthy(settings.reasoningEffort) &&
      settings.provider === undefined
    )
      return yield* write({ ...settings, provider: "openai" });
    return settings;
  });
  return {
    read: updates.withPermit(read),
    /** Merges and writes atomically, so a crash never leaves half a config file. */
    update: (patch: Partial<Settings>) =>
      updates.withPermit(
        Effect.gen(function* () {
          const current = yield* read;
          return yield* write({ ...current, ...patch });
        }),
      ),
  };
});

export type GlobalConfigApi = Effect.Success<typeof make>;

/** `<storage>/config.json`. */
export class GlobalConfig extends Context.Service<GlobalConfig, GlobalConfigApi>()(
  "memory-agent/config/global-config/GlobalConfig",
) {
  static readonly layer = Layer.effect(GlobalConfig, make).pipe(
    Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
  );
}
