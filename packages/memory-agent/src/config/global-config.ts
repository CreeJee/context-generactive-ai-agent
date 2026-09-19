import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { ProviderId } from "../providers/contracts.ts";
import { StorageRoot } from "./storage-root.ts";

/**
 * How the embedding model runs. `auto` picks `gpu` on a machine with enough memory where WebGPU
 * was found to work, and `cpu` otherwise.
 */
export const EmbeddingChoice = Schema.Literal("auto", "cpu", "gpu");
export type EmbeddingChoice = typeof EmbeddingChoice.Type;

/** Whether the full-precision model ran on WebGPU when this machine was last checked. */
export const GpuCheck = Schema.Union(
  Schema.Struct({ status: Schema.Literal("available"), checkedAt: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    checkedAt: Schema.String,
    reason: Schema.String,
  }),
);
export type GpuCheck = typeof GpuCheck.Type;

/** User-wide settings. Secrets never go here; they belong in the OS keychain. */
export const Settings = Schema.Struct({
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
  /** Takes effect when the app next starts; `auto` when unset. */
  embeddingDevice: Schema.optional(EmbeddingChoice),
  gpuCheck: Schema.optional(GpuCheck),
});
export type Settings = typeof Settings.Type;

const decodeSettings = Schema.decodeUnknownSync(Schema.parseJson(Settings));

const make = Effect.gen(function* () {
  const storage = yield* StorageRoot;
  const file = join(storage.path, "config.json");

  const write = (settings: Settings) => {
    mkdirSync(storage.path, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  };

  const read = (): Settings => {
    if (!existsSync(file)) return {};
    const settings = decodeSettings(readFileSync(file, "utf8"));
    if (settings.model && settings.reasoningEffort && settings.provider === undefined) {
      const migrated = { ...settings, provider: "openai" as const };
      write(migrated);
      return migrated;
    }
    return settings;
  };

  return {
    read: Effect.sync(read),
    /** Merges and writes atomically, so a crash never leaves half a config file. */
    update: (patch: Partial<Settings>) =>
      Effect.sync(() => {
        const next = { ...read(), ...patch };
        write(next);
        return next;
      }),
  };
});

/** `<storage>/config.json`. */
export class GlobalConfig extends Context.Tag("memory-agent/GlobalConfig")<
  GlobalConfig,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.effect(GlobalConfig, make);
}
