// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { DatabaseSync } from "node:sqlite";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Path, Schedule, Schema, Scope } from "effect";
import { describe, expect } from "vite-plus/test";
import { RelayedApprovals, type RelayedRequest } from "../src/approvals/relayed.ts";
import { Database } from "../src/db/database.ts";
import { sdkCancellation } from "./support/sdk-cancellation.ts";

const request: RelayedRequest = {
  requester: { kind: "subagent", subagentId: "child", name: null },
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
  use: (
    relay: RelayedApprovals["Service"],
    database: Database["Service"],
  ) => Effect.Effect<A, E, R>,
  timeoutMs = 60_000,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const databaseContext = yield* Layer.build(Database.layer(":memory:"));
      const database = yield* Effect.provideContext(Database, databaseContext);
      const relayContext = yield* Layer.build(
        RelayedApprovals.layerWith({ timeoutMs }).pipe(
          Layer.provide(Layer.succeedContext(databaseContext)),
        ),
      );
      const relay = yield* Effect.provideContext(RelayedApprovals, relayContext);
      return yield* use(relay, database);
    }),
  );

const openRelay = Effect.fnUntraced(function* (file: string) {
  const scope = yield* Scope.make();
  const databaseContext = yield* Layer.build(Database.layer(file)).pipe(
    Effect.provideService(Scope.Scope, scope),
  );
  const database = yield* Effect.provideContext(Database, databaseContext);
  const relayContext = yield* Layer.build(
    RelayedApprovals.layerWith({ timeoutMs: 60_000 }).pipe(
      Layer.provide(Layer.succeedContext(databaseContext)),
    ),
  ).pipe(Effect.provideService(Scope.Scope, scope));
  const relay = yield* Effect.provideContext(RelayedApprovals, relayContext);
  return { database, relay, scope };
});

const pending = (relay: RelayedApprovals["Service"], sessionId: string, count: number) =>
  relay.pending(sessionId).pipe(
    Effect.filterOrFail(
      (approvals) => approvals.length === count,
      (approvals) => approvals.length,
    ),
    Effect.retry(Schedule.recurs(100)),
  );

const completed = (database: Database["Service"]) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const row = database.sqlite
        .prepare(
          "SELECT status FROM owner_workflow_executions WHERE workflow_name = 'RelayedApprovalExecution'",
        )
        .get();
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
    withRelay((relay, database) =>
      Effect.gen(function* () {
        const { controller } = yield* sdkCancellation;
        const waiting = relay.ask("s", "run-1", request, controller.signal);
        const [approval] = yield* pending(relay, "s", 1);
        controller.abort();
        expect(yield* result(waiting)).toBe(false);
        expect(yield* pending(relay, "s", 0)).toEqual([]);
        expect(yield* relay.answer("s", approval!.id, true)).toBe(false);
        expect(
          database.sqlite
            .prepare(
              "SELECT status FROM owner_workflow_executions WHERE workflow_name = 'RelayedApprovalExecution'",
            )
            .get(),
        ).toEqual({ status: "interrupted" });
        expect(
          database.sqlite
            .prepare(
              "SELECT COUNT(*) AS count FROM owner_workflow_clocks WHERE status = 'scheduled'",
            )
            .get(),
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
        expect(
          reopened.database.sqlite
            .prepare(
              "SELECT COUNT(*) AS count FROM owner_workflow_clocks WHERE status = 'scheduled'",
            )
            .get(),
        ).toEqual({ count: 1 });
        expect(yield* reopened.relay.answer("s", approval!.id, true)).toBe(true);
        expect(yield* reopened.relay.pending("s")).toEqual([]);
        expect(
          reopened.database.sqlite
            .prepare(
              "SELECT COUNT(*) AS count FROM owner_workflow_clocks WHERE status = 'scheduled'",
            )
            .get(),
        ).toEqual({ count: 0 });
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

        const sqlite = new DatabaseSync(file);
        sqlite
          .prepare("UPDATE owner_workflow_clocks SET due_at = 0 WHERE status = 'scheduled'")
          .run();
        sqlite.close();

        const reopened = yield* openRelay(file);
        yield* completed(reopened.database);
        expect(yield* reopened.relay.pending("s")).toEqual([]);
        expect(yield* reopened.relay.answer("s", approval!.id, true)).toBe(false);
        yield* Scope.close(reopened.scope, Exit.void);
      }),
    ).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])),
  );
});
