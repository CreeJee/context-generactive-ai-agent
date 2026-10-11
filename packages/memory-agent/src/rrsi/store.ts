import { Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
import { oauthProtocolCrypto } from "../oauth/node-runtime.ts";
import type { DatabaseSync } from "node:sqlite";
import { Config, ConfigProvider, DateTime, Context, Effect, Layer, Schema } from "effect";
import { Database } from "../db/database.ts";
import {
  baselineProfile,
  defaultSettings,
  Experiment,
  Settings,
  Version,
  type HarnessProfile,
  type HarnessVersion,
  type ExperimentRecord,
} from "./contracts.ts";

const Row = Schema.Struct({ payload: Schema.String });
// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const decodeVersion = EffectFunction.flow(
  Schema.decodeUnknownResult(Schema.fromJsonString(Version)),
  Result.getOrThrow,
);
// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const decodeExperiment = EffectFunction.flow(
  Schema.decodeUnknownResult(Schema.fromJsonString(Experiment)),
  Result.getOrThrow,
);
export const profileHash = (profile: HarnessProfile) =>
  Buffer.from(
    Effect.runSync(
      oauthProtocolCrypto.digest("SHA-256", new TextEncoder().encode(JSON.stringify(profile))),
    ),
  ).toString("hex");
export function makeHarnessStore(db: { sqlite: DatabaseSync; atomic: <A>(work: () => A) => A }) {
  const { sqlite, atomic } = db;
  const insert = sqlite.prepare("INSERT INTO rrsi_versions VALUES (?, ?)");
  const read = sqlite.prepare("SELECT payload FROM rrsi_versions WHERE id=?");
  const state = sqlite.prepare("SELECT version_id, settings FROM rrsi_state WHERE id=1");
  const pin = sqlite.prepare("SELECT version_id FROM rrsi_goal_pins WHERE goal_id=?");
  const get = (id: string): HarnessVersion => {
    // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
    const version = decodeVersion(
      EffectFunction.flow(Schema.decodeUnknownResult(Row), Result.getOrThrow)(read.get(id)).payload,
    );
    if (version.artifactHash !== profileHash(version.profile))
      throw new Error("harness_integrity_failed");
    return version;
  };
  atomic(() => {
    const base: HarnessVersion = {
      id: "baseline",
      parentId: null,
      profile: baselineProfile,
      kind: "profile",
      sourceCommit: null,
      artifactHash: profileHash(baselineProfile),
      createdAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
    };
    if (!isTruthy(read.get(base.id))) insert.run(base.id, JSON.stringify(base));
    sqlite
      .prepare("INSERT OR IGNORE INTO rrsi_state VALUES (1, ?, ?)")
      .run(base.id, JSON.stringify(defaultSettings));
    sqlite
      .prepare(
        "INSERT OR IGNORE INTO rrsi_goal_pins SELECT goal_instance_id, 'baseline' FROM workflow_goal_identities",
      )
      .run();
    // Interrupted local experiments have uncertain measurements, never auto-adopt them after restart.
    const interrupted = sqlite
      .prepare(
        "SELECT payload FROM rrsi_experiments WHERE json_extract(payload, '$.status')='running'",
      )
      .all();
    for (const row of interrupted) {
      // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
      const prior = decodeExperiment(
        EffectFunction.flow(Schema.decodeUnknownResult(Row), Result.getOrThrow)(row).payload,
      );
      sqlite.prepare("UPDATE rrsi_experiments SET payload=? WHERE id=?").run(
        JSON.stringify({
          ...prior,
          status: "cancelled",
          finishedAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
          reason: "owner_restarted",
        }),
        prior.id,
      );
    }
  });
  const settings = () =>
    // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
    EffectFunction.flow(
      Schema.decodeResult(Schema.fromJsonString(Settings)),
      Result.getOrThrow,
    )(
      // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
      EffectFunction.flow(
        Schema.decodeUnknownResult(Schema.Struct({ settings: Schema.String })),
        Result.getOrThrow,
      )(state.get()).settings,
    );
  const current = () =>
    get(
      // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
      EffectFunction.flow(
        Schema.decodeUnknownResult(Schema.Struct({ version_id: Schema.String })),
        Result.getOrThrow,
      )(state.get()).version_id,
    );
  return {
    get,
    current,
    settings,
    versions: () =>
      sqlite
        .prepare("SELECT payload FROM rrsi_versions ORDER BY rowid DESC")
        .all()
        // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
        .map((row) =>
          get(
            decodeVersion(
              EffectFunction.flow(Schema.decodeUnknownResult(Row), Result.getOrThrow)(row).payload,
            ).id,
          ),
        ),
    configure: (input: typeof Settings.Type) =>
      sqlite
        .prepare("UPDATE rrsi_state SET settings=? WHERE id=1")
        // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
        .run(
          JSON.stringify(
            EffectFunction.flow(Schema.decodeResult(Settings), Result.getOrThrow)(input),
          ),
        ),
    forGoal: (goalId: string | null) =>
      atomic(() => {
        if (!isTruthy(goalId))
          // Native host/SDK configuration boundary reads or forwards the host environment.
          return Effect.runSync(
            Config.String("CONTEXT_AGENT_RRSI_WORKER")
              .pipe(Config.withDefault(""))
              .parse(ConfigProvider.fromEnv())
              .pipe(Effect.orDie),
          ) === "1"
            ? current()
            : get("baseline");
        // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
        const saved = EffectFunction.flow(
          Schema.decodeUnknownResult(
            Schema.UndefinedOr(Schema.Struct({ version_id: Schema.String })),
          ),
          Result.getOrThrow,
        )(pin.get(goalId));
        if (isTruthy(saved)) return get(saved.version_id);
        // Old Goals retain baseline semantics even if their first run with this build is a resume.
        const version = current();
        sqlite.prepare("INSERT INTO rrsi_goal_pins VALUES (?, ?)").run(goalId, version.id);
        return version;
      }),
    adopt: (profile: HarnessProfile, expected: string, sourceCommit: string | null = null) =>
      atomic(() => {
        if (current().id !== expected) throw new Error("harness_frontier_changed");
        const version: HarnessVersion = {
          id: Effect.runSync(oauthProtocolCrypto.randomUUIDv4()),
          parentId: expected,
          profile,
          kind: "profile",
          sourceCommit,
          artifactHash: profileHash(profile),
          createdAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
        };
        insert.run(version.id, JSON.stringify(version));
        sqlite.prepare("UPDATE rrsi_state SET version_id=? WHERE id=1").run(version.id);
        return version;
      }),
    restore: (id: string) =>
      atomic(() => {
        get(id);
        sqlite.prepare("UPDATE rrsi_state SET version_id=? WHERE id=1").run(id);
      }),
    saveExperiment: (record: ExperimentRecord) => {
      // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
      const parsed = EffectFunction.flow(
        Schema.decodeResult(Experiment),
        Result.getOrThrow,
      )(record);
      sqlite
        .prepare(
          "INSERT INTO rrsi_experiments VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
        )
        .run(parsed.id, JSON.stringify(parsed));
    },
    experiments: () =>
      sqlite
        .prepare("SELECT payload FROM rrsi_experiments ORDER BY rowid DESC LIMIT 30")
        .all()
        // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
        .map((row) =>
          decodeExperiment(
            EffectFunction.flow(Schema.decodeUnknownResult(Row), Result.getOrThrow)(row).payload,
          ),
        ),
  };
}
export class HarnessStore extends Context.Service<
  HarnessStore,
  ReturnType<typeof makeHarnessStore>
>()("memory-agent/rrsi/store/HarnessStore") {
  static readonly layer = Layer.effect(
    HarnessStore,
    Effect.gen(function* () {
      return makeHarnessStore(yield* Database);
    }),
  );
}
