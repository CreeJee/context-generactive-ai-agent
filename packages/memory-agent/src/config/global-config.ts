import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { StorageRoot } from "./storage-root.ts";

/** User-wide settings. Secrets never go here; they belong in the OS keychain. */
export const Settings = Schema.Struct({
  /** Model id chosen from the signed-in account's model list. */
  model: Schema.optional(Schema.String),
  /** One of the efforts that model advertises, e.g. "low" or "high". */
  reasoningEffort: Schema.optional(Schema.NonEmptyString),
});
export type Settings = typeof Settings.Type;

const decodeSettings = Schema.decodeUnknownSync(Schema.parseJson(Settings));

const make = Effect.gen(function* () {
  const storage = yield* StorageRoot;
  const file = join(storage.path, "config.json");

  const read = (): Settings => (existsSync(file) ? decodeSettings(readFileSync(file, "utf8")) : {});

  return {
    read: Effect.sync(read),
    /** Merges and writes atomically, so a crash never leaves half a config file. */
    update: (patch: Partial<Settings>) =>
      Effect.sync(() => {
        const next = { ...read(), ...patch };
        mkdirSync(storage.path, { recursive: true, mode: 0o700 });
        const temporary = `${file}.${process.pid}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        renameSync(temporary, file);
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
