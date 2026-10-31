import { isTruthy } from "../truthy.ts";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Schema,
  SchemaTransformation,
  Semaphore,
} from "effect";
import { ProviderId } from "../providers/contracts.ts";
import {
  CompatibleAccounts,
  OpenAICompatibleConfiguration,
} from "../providers/openai-compatible-config.ts";
import {
  CrossProviderMediaConsentSettings,
  EmbeddingChoice,
  GpuCheck,
  KanbanConcurrency,
  SummaryStartPercent,
} from "./contracts.ts";
import { StorageRoot } from "./storage-root.ts";

/**
 * `gpuCheck` as releases up to 0.0.17 wrote it: the case named under `status`. A settings file in
 * that form is written back in the current form the first time it is read.
 */
const LegacyGpuCheck = Schema.Union([
  Schema.Struct({ status: Schema.Literal("available"), checkedAt: Schema.String }).pipe(
    Schema.decodeTo(
      GpuCheck.cases.available,
      SchemaTransformation.transform({
        decode: ({ checkedAt }) => GpuCheck.cases.available.make({ checkedAt }),
        encode: ({ checkedAt }) => ({ status: "available" as const, checkedAt }),
      }),
    ),
  ),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    checkedAt: Schema.String,
    reason: Schema.String,
  }).pipe(
    Schema.decodeTo(
      GpuCheck.cases.unavailable,
      SchemaTransformation.transform({
        decode: ({ checkedAt, reason }) => GpuCheck.cases.unavailable.make({ checkedAt, reason }),
        encode: ({ checkedAt, reason }) => ({
          status: "unavailable" as const,
          checkedAt,
          reason,
        }),
      }),
    ),
  ),
]);
const legacyGpuCheck = Schema.decodeUnknownOption(LegacyGpuCheck);

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

/** User-wide settings. Secrets never go here; they belong in the OS keychain. */
export const Settings = Schema.Struct({
  /** The single endpoint of releases before compatible accounts; read via `compatibleAccountsOf`. */
  openaiCompatible: Schema.optional(OpenAICompatibleConfiguration),
  compatibleAccounts: Schema.optional(CompatibleAccounts),
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
  /** Half the CPU cores (1 to 4) when unset; read via `KanbanSettings`. */
  kanbanConcurrency: Schema.optional(KanbanConcurrency),
  /** Also search other projects' memory (those not excluded). Off when unset. */
  crossProjectRecall: Schema.optional(Schema.Boolean),
  /** Send matching memory to an external agent in a direct conversation. Off when unset. */
  externalAgentMemory: Schema.optional(Schema.Boolean),
  /** Send defects to the developer's Discord webhook when one is set. On when unset. */
  defectReports: Schema.optional(Schema.Boolean),
});
export type Settings = typeof Settings.Type;

export const GlobalConfigFailedReason = Schema.TaggedUnion({
  MissingFile: {},
  ReadFailed: {},
  WriteFailed: {},
  InvalidSettings: {},
});

export class GlobalConfigFailed extends Schema.TaggedError<
  GlobalConfigFailed,
  { readonly brand: unique symbol }
>()("GlobalConfigFailed", {
  operation: Schema.Literals(["read", "write"]),
  reason: GlobalConfigFailedReason,
  cause: Schema.Defect(),
}) {}

const make = Effect.gen(function* () {
  const storage = yield* StorageRoot;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(storage.path, "config.json");

  const updates = Semaphore.makeUnsafe(1);
  const jsonSettings = Schema.fromJsonString(Settings, { space: 2 });
  const storedFile = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
  const invalidSettings = (cause: unknown) =>
    GlobalConfigFailed.make({
      operation: "read",
      reason: GlobalConfigFailedReason.cases.InvalidSettings.make({}),
      cause,
    });
  const write = (settings: Settings) =>
    Effect.gen(function* () {
      const json = yield* Schema.encodeEffect(jsonSettings)(settings).pipe(
        Effect.mapError((cause) =>
          GlobalConfigFailed.make({
            operation: "write",
            reason: GlobalConfigFailedReason.cases.InvalidSettings.make({}),
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
          GlobalConfigFailed.make({
            operation: "write",
            reason: GlobalConfigFailedReason.cases.WriteFailed.make({}),
            cause,
          }),
        ),
      );
      return settings;
    });
  const read = Effect.gen(function* () {
    const json = yield* fs.readFileString(file).pipe(
      Effect.mapError((cause) =>
        GlobalConfigFailed.make({
          operation: "read",
          reason: Predicate.isTagged(cause.reason, "NotFound")
            ? GlobalConfigFailedReason.cases.MissingFile.make({})
            : GlobalConfigFailedReason.cases.ReadFailed.make({}),
          cause,
        }),
      ),
      Effect.catchReason("GlobalConfigFailed", "MissingFile", () => Effect.succeed(null)),
    );
    if (json === null) return {};
    const stored = yield* Schema.decodeEffect(storedFile)(json).pipe(
      Effect.mapError(invalidSettings),
    );
    const migratedGpuCheck = legacyGpuCheck(stored.gpuCheck);
    const settings = yield* Schema.decodeEffect(Settings)(
      Option.match(migratedGpuCheck, {
        onNone: () => stored,
        onSome: (gpuCheck) => ({ ...stored, gpuCheck }),
      }),
    ).pipe(Effect.mapError(invalidSettings));
    // A model with an effort but no provider is a setting of releases before providers: OpenAI's.
    const legacyProvider =
      isTruthy(settings.model) &&
      isTruthy(settings.reasoningEffort) &&
      settings.provider === undefined;
    // An older file is written back once, so later reads take the current form only.
    return Option.isSome(migratedGpuCheck) || legacyProvider
      ? yield* write(legacyProvider ? { ...settings, provider: "openai" } : settings)
      : settings;
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
