import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Context, Effect, Layer, Schema } from "effect";
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
const decodeVersion = Schema.decodeUnknownSync(Schema.fromJsonString(Version));
const decodeExperiment = Schema.decodeUnknownSync(Schema.fromJsonString(Experiment));
export const profileHash = (profile: HarnessProfile) =>
  createHash("sha256").update(JSON.stringify(profile)).digest("hex");
export function makeHarnessStore(db: { sqlite: DatabaseSync; atomic: <A>(work: () => A) => A }) {
  const { sqlite, atomic } = db;
  const insert = sqlite.prepare("INSERT INTO rrsi_versions VALUES (?, ?)");
  const read = sqlite.prepare("SELECT payload FROM rrsi_versions WHERE id=?");
  const state = sqlite.prepare("SELECT version_id, settings FROM rrsi_state WHERE id=1");
  const pin = sqlite.prepare("SELECT version_id FROM rrsi_goal_pins WHERE goal_id=?");
  const get = (id: string): HarnessVersion => {
    const version = decodeVersion(Schema.decodeUnknownSync(Row)(read.get(id)).payload);
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
      createdAt: Date.now(),
    };
    if (!read.get(base.id)) insert.run(base.id, JSON.stringify(base));
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
      const prior = decodeExperiment(Schema.decodeUnknownSync(Row)(row).payload);
      sqlite.prepare("UPDATE rrsi_experiments SET payload=? WHERE id=?").run(
        JSON.stringify({
          ...prior,
          status: "cancelled",
          finishedAt: Date.now(),
          reason: "owner_restarted",
        }),
        prior.id,
      );
    }
  });
  const settings = () =>
    Schema.decodeUnknownSync(Schema.fromJsonString(Settings))(
      Schema.decodeUnknownSync(Schema.Struct({ settings: Schema.String }))(state.get()).settings,
    );
  const current = () =>
    get(
      Schema.decodeUnknownSync(Schema.Struct({ version_id: Schema.String }))(state.get())
        .version_id,
    );
  return {
    get,
    current,
    settings,
    versions: () =>
      sqlite
        .prepare("SELECT payload FROM rrsi_versions ORDER BY rowid DESC")
        .all()
        .map((row) => get(decodeVersion(Schema.decodeUnknownSync(Row)(row).payload).id)),
    configure: (input: typeof Settings.Type) =>
      sqlite
        .prepare("UPDATE rrsi_state SET settings=? WHERE id=1")
        .run(JSON.stringify(Schema.decodeUnknownSync(Settings)(input))),
    forGoal: (goalId: string | null) =>
      atomic(() => {
        if (!goalId)
          return process.env.CONTEXT_AGENT_RRSI_WORKER === "1" ? current() : get("baseline");
        const saved = Schema.decodeUnknownSync(
          Schema.UndefinedOr(Schema.Struct({ version_id: Schema.String })),
        )(pin.get(goalId));
        if (saved) return get(saved.version_id);
        // Old Goals retain baseline semantics even if their first run with this build is a resume.
        const version = current();
        sqlite.prepare("INSERT INTO rrsi_goal_pins VALUES (?, ?)").run(goalId, version.id);
        return version;
      }),
    adopt: (profile: HarnessProfile, expected: string, sourceCommit: string | null = null) =>
      atomic(() => {
        if (current().id !== expected) throw new Error("harness_frontier_changed");
        const version: HarnessVersion = {
          id: randomUUID(),
          parentId: expected,
          profile,
          kind: "profile",
          sourceCommit,
          artifactHash: profileHash(profile),
          createdAt: Date.now(),
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
      const parsed = Schema.decodeUnknownSync(Experiment)(record);
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
        .map((row) => decodeExperiment(Schema.decodeUnknownSync(Row)(row).payload)),
  };
}
export class HarnessStore extends Context.Service<
  HarnessStore,
  ReturnType<typeof makeHarnessStore>
>()("memory-agent/rrsi/HarnessStore") {
  static readonly layer = Layer.effect(
    HarnessStore,
    Effect.gen(function* () {
      return makeHarnessStore(yield* Database);
    }),
  );
}
