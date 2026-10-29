import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Context, Effect, Exit, FileSystem, Layer, Path, Schema, Scope } from "effect";
import { DatabaseSync } from "node:sqlite";
import { SqlClient } from "effect/sql";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { humanDecisionFactsMigration, migrations } from "../src/db/migrations.ts";
import { HumanDecisionPayload } from "../src/kanban/human-decision-schema.ts";
import {
  OwnerWorkflowStorage,
  ownerWorkflowStorageLayer,
} from "../src/workflow/owner-workflow-storage.ts";
import { sqlAll } from "./support/sql.ts";

const identity = (cardId: string) => ({
  sessionId: "s",
  goalInstanceId: "g",
  cardId,
  key: `retry_exhausted:${cardId}`,
});
const kind = { _tag: "RetryExhausted", attempts: 3 };
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
/** The payload as the app encodes it, which asking the same occasion again compares. */
const encodePayload = Schema.encodeEffect(Schema.fromJsonString(HumanDecisionPayload));
/** A request as 0.0.17 stored it: the facts and the time it asked ride in the payload. */
const legacy = (cardId: string, createdAt: number) =>
  encodeJson({ ...identity(cardId), kind, createdAt });

const tempFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return path.join(yield* fs.makeTempDirectoryScoped({ prefix: "human-decision-" }), "owner.db");
}).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer]));

describe("human decision rows from 0.0.17", () => {
  it.effect("move their facts out of the payload and keep their identity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* tempFile;
        const rows = [
          { id: "waiting", status: "suspended", payload: yield* legacy("a", 1_000) },
          { id: "answered", status: "completed", payload: yield* legacy("b", 2_000) },
          { id: "closed", status: "interrupted", payload: yield* legacy("c", 3_000) },
          {
            id: "unreadable",
            status: "suspended",
            payload: yield* encodeJson({
              ...identity("d"),
              kind: { _tag: "Unknown" },
              createdAt: 4_000,
            }),
          },
        ];
        const kindJson = yield* encodeJson(kind);
        const factsMigration = migrations.indexOf(humanDecisionFactsMigration);
        expect(factsMigration).toBeGreaterThanOrEqual(0);
        yield* Effect.acquireUseRelease(
          Effect.sync(() => new DatabaseSync(file)),
          (sqlite) =>
            Effect.sync(() => {
              sqlite.exec("PRAGMA foreign_keys = OFF");
              migrations.slice(0, factsMigration).forEach((step) => sqlite.exec(step));
              sqlite.exec(`PRAGMA user_version = ${factsMigration}`);
              const insert = sqlite.prepare(
                "INSERT INTO owner_workflow_executions (execution_id, workflow_name, payload_json, status) VALUES (?, 'HumanDecisionExecution', ?, ?)",
              );
              rows.forEach((row) => insert.run(row.id, row.payload, row.status));
              sqlite.exec(
                "INSERT INTO human_decision_closures VALUES ('closed', 'card_stopped', 'old')",
              );
            }),
          (sqlite) => Effect.sync(() => sqlite.close()),
        );

        const scope = yield* Scope.make();
        const context = yield* Layer.build(
          ownerWorkflowStorageLayer.pipe(Layer.provideMerge(Database.layer(file))),
        ).pipe(Effect.provideService(Scope.Scope, scope));
        const sql = Context.get(context, SqlClient.SqlClient);
        const storage = Context.get(context, OwnerWorkflowStorage);
        yield* Effect.gen(function* () {
          expect(
            yield* sqlAll(
              "SELECT execution_id, payload_json, created_at FROM owner_workflow_executions ORDER BY execution_id",
            ),
          ).toEqual([
            {
              execution_id: "answered",
              payload_json: yield* encodePayload(identity("b")),
              created_at: 2_000,
            },
            {
              execution_id: "closed",
              payload_json: yield* encodePayload(identity("c")),
              created_at: 3_000,
            },
            { execution_id: "unreadable", payload_json: rows[3]?.payload, created_at: null },
            {
              execution_id: "waiting",
              payload_json: yield* encodePayload(identity("a")),
              created_at: 1_000,
            },
          ]);
          expect(
            yield* sqlAll(
              "SELECT execution_id, seq, kind_json, observed_at FROM human_decision_facts ORDER BY execution_id",
            ),
          ).toEqual(
            [
              ["answered", 2_000],
              ["closed", 3_000],
              ["waiting", 1_000],
            ].map(([id, at]) => ({
              execution_id: id,
              seq: 1,
              kind_json: kindJson,
              observed_at: at,
            })),
          );
          // Asking the same occasion again is the same request, not a conflicting one.
          expect(
            yield* storage.admit({
              workflowName: "HumanDecisionExecution",
              executionId: "waiting",
              payload: identity("a"),
            }),
          ).toMatchObject({ executionId: "waiting", status: "suspended" });
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
        yield* Scope.close(scope, Exit.void);
      }),
    ),
  );
});
