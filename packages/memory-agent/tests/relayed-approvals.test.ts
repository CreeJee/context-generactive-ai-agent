import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { SqlClient } from "effect/sql";
import {
  Cause,
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  Schedule,
  Schema,
  Scope,
} from "effect";
import { DatabaseSync } from "node:sqlite";
import { describe, expect } from "vite-plus/test";
import { RelayedApprovals, type RelayedRequest } from "../src/approvals/relayed.ts";
import { ApprovalRequester } from "../src/approvals/relayed-state.ts";
import { Database } from "../src/db/database.ts";
import { migrations } from "../src/db/migrations.ts";
import { sdkCancellation } from "./support/sdk-cancellation.ts";
import { sqlGet, sqlRun } from "./support/sql.ts";

const request: RelayedRequest = {
  requester: ApprovalRequester.cases.subagent.make({ subagentId: "child", name: null }),
  toolName: "write_file",
  argumentsJson: "{}",
  reason: "Approve this write",
  askedBy: "every_call",
};

const result = <A>(promise: Promise<A>) =>
  Effect.tryPromise({
    try: () => promise,
    catch: (cause) => new Cause.UnknownError(cause),
  });

const withRelay = <A, E, R>(
  use: (relay: RelayedApprovals["Service"]) => Effect.Effect<A, E, R | SqlClient.SqlClient>,
  timeoutMs = 60_000,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const databaseContext = yield* Layer.build(Database.layer(":memory:"));
      const relayContext = yield* Layer.build(
        RelayedApprovals.layerWith({ timeoutMs }).pipe(
          Layer.provide(Layer.succeedContext(databaseContext)),
        ),
      );
      const relay = yield* Effect.provideContext(RelayedApprovals, relayContext);
      return yield* use(relay).pipe(
        Effect.provideService(
          SqlClient.SqlClient,
          Context.get(databaseContext, SqlClient.SqlClient),
        ),
      );
    }),
  );

const openRelay = Effect.fnUntraced(function* (file: string) {
  const scope = yield* Scope.make();
  const databaseContext = yield* Layer.build(Database.layer(file)).pipe(
    Effect.provideService(Scope.Scope, scope),
  );
  const sql = Context.get(databaseContext, SqlClient.SqlClient);
  const relayContext = yield* Layer.build(
    RelayedApprovals.layerWith({ timeoutMs: 60_000 }).pipe(
      Layer.provide(Layer.succeedContext(databaseContext)),
    ),
  ).pipe(Effect.provideService(Scope.Scope, scope));
  const relay = yield* Effect.provideContext(RelayedApprovals, relayContext);
  return { sql, relay, scope };
});

const pending = (relay: RelayedApprovals["Service"], sessionId: string, count: number) =>
  relay.pending(sessionId).pipe(
    Effect.filterOrFail(
      (approvals) => approvals.length === count,
      (approvals) => approvals.length,
    ),
    Effect.retry(Schedule.recurs(100)),
  );

const completed = () =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const row = yield* sqlGet(
        "SELECT status FROM owner_workflow_executions WHERE workflow_name = 'RelayedApprovalExecution'",
      );
      if (Schema.is(Schema.Struct({ status: Schema.String }))(row) && row.status === "completed")
        return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.fail("approval workflow did not complete");
  });

describe("durable relayed approvals", () => {
  it.live(
    "isolates session/run approvals and treats same-value duplicate answers idempotently",
    () =>
      withRelay((relay) =>
        Effect.gen(function* () {
          const { controller } = yield* sdkCancellation;
          const first = relay.ask("s", "run-1", request, controller.signal);
          const second = relay.ask("s", "run-2", request, controller.signal);
          const [a, b] = yield* pending(relay, "s", 2);
          expect(yield* relay.answer("other", b!.id, true)).toBe(false);
          expect(yield* relay.answer("s", b!.id, true)).toBe(true);
          expect(yield* relay.answer("s", b!.id, true)).toBe(true);
          expect(yield* relay.answer("s", b!.id, false)).toBe(false);
          expect(yield* relay.answer("s", a!.id, false)).toBe(true);
          expect(yield* Effect.forEach([first, second], result, { concurrency: 2 })).toEqual([
            false,
            true,
          ]);
          expect(yield* relay.pending("s")).toEqual([]);
        }),
      ),
  );

  it.live("interrupts a cancelled owner's durable wait and rejects a late answer", () =>
    withRelay((relay) =>
      Effect.gen(function* () {
        const { controller } = yield* sdkCancellation;
        const waiting = relay.ask("s", "run-1", request, controller.signal);
        const [approval] = yield* pending(relay, "s", 1);
        controller.abort();
        expect(yield* result(waiting)).toBe(false);
        expect(yield* pending(relay, "s", 0)).toEqual([]);
        expect(yield* relay.answer("s", approval!.id, true)).toBe(false);
        expect(
          yield* sqlGet(
            "SELECT status FROM owner_workflow_executions WHERE workflow_name = 'RelayedApprovalExecution'",
          ),
        ).toEqual({ status: "interrupted" });
        expect(
          yield* sqlGet(
            "SELECT COUNT(*) AS count FROM owner_workflow_clocks WHERE status = 'scheduled'",
          ),
        ).toEqual({ count: 0 });
      }),
    ),
  );

  it.live("re-registers and resumes a pending approval after process-layer restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "relayed-approval-" });
        const file = path.join(directory, "owner.db");
        const first = yield* openRelay(file);
        const { controller } = yield* sdkCancellation;
        const waiting = first.relay.ask("s", "run-1", request, controller.signal);
        void waiting.catch(() => false);
        const [approval] = yield* pending(first.relay, "s", 1);
        yield* Scope.close(first.scope, Exit.void);

        const reopened = yield* openRelay(file);
        expect((yield* reopened.relay.pending("s")).map((entry) => entry.id)).toEqual([
          approval!.id,
        ]);
        const scheduled = sqlGet(
          "SELECT COUNT(*) AS count FROM owner_workflow_clocks WHERE status = 'scheduled'",
        ).pipe(Effect.provideService(SqlClient.SqlClient, reopened.sql));
        expect(yield* scheduled).toEqual({ count: 1 });
        expect(yield* reopened.relay.answer("s", approval!.id, true)).toBe(true);
        expect(yield* reopened.relay.pending("s")).toEqual([]);
        expect(yield* scheduled).toEqual({ count: 0 });
        yield* Scope.close(reopened.scope, Exit.void);
      }),
    ).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])),
  );

  it.live("resumes an approval whose requester 0.0.17 stored under kind", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "relayed-requester-" });
        const file = path.join(directory, "owner.db");
        const first = yield* openRelay(file);
        const { controller } = yield* sdkCancellation;
        const waiting = first.relay.ask("s", "run-1", request, controller.signal);
        void waiting.catch(() => false);
        const [approval] = yield* pending(first.relay, "s", 1);
        yield* Scope.close(first.scope, Exit.void);

        const requesterMigration = migrations.findIndex((step) =>
          step.includes("relayed approval's requester names its case"),
        );
        expect(requesterMigration).toBeGreaterThanOrEqual(0);
        yield* Effect.acquireUseRelease(
          Effect.sync(() => new DatabaseSync(file)),
          (sqlite) =>
            Effect.sync(() => {
              // The payload as 0.0.17 wrote it, with the requester's case under kind.
              sqlite.exec(`UPDATE owner_workflow_executions
                SET payload_json = json_set(payload_json, '$.requester',
                  json_object('kind', 'subagent', 'subagentId', 'child', 'name', NULL))
                WHERE workflow_name = 'RelayedApprovalExecution'`);
              // Only this step runs again: replaying every later step would recreate their tables.
              sqlite.exec(migrations[requesterMigration]!);
            }),
          (sqlite) => Effect.sync(() => sqlite.close()),
        );

        const reopened = yield* openRelay(file);
        expect(yield* reopened.relay.pending("s")).toMatchObject([
          {
            id: approval!.id,
            requester: ApprovalRequester.cases.subagent.make({ subagentId: "child", name: null }),
          },
        ]);
        expect(yield* reopened.relay.answer("s", approval!.id, true)).toBe(true);
        expect(yield* reopened.relay.pending("s")).toEqual([]);
        yield* Scope.close(reopened.scope, Exit.void);
      }),
    ).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])),
  );

  it.live("recovers an overdue durable timeout and rejects the losing approval", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "relayed-timeout-" });
        const file = path.join(directory, "owner.db");
        const first = yield* openRelay(file);
        const { controller } = yield* sdkCancellation;
        const waiting = first.relay.ask("s", "run-1", request, controller.signal);
        void waiting.catch(() => false);
        const [approval] = yield* pending(first.relay, "s", 1);
        yield* Scope.close(first.scope, Exit.void);

        yield* Effect.scoped(
          Effect.gen(function* () {
            const closed = yield* Layer.build(Database.layer(file));
            yield* sqlRun(
              "UPDATE owner_workflow_clocks SET due_at = 0 WHERE status = 'scheduled'",
            ).pipe(
              Effect.provideService(SqlClient.SqlClient, Context.get(closed, SqlClient.SqlClient)),
            );
          }),
        );

        const reopened = yield* openRelay(file);
        yield* completed().pipe(Effect.provideService(SqlClient.SqlClient, reopened.sql));
        expect(yield* reopened.relay.pending("s")).toEqual([]);
        expect(yield* reopened.relay.answer("s", approval!.id, true)).toBe(false);
        yield* Scope.close(reopened.scope, Exit.void);
      }),
    ).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])),
  );
});
