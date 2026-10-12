import { Effect, Schema } from "effect";
import { Database, SessionLeases } from "memory-agent";
import { expect } from "vite-plus/test";
import {
  TestEnv,
  testAgent,
  type AgentServices,
} from "../../../../packages/memory-agent/tests/support/test-env.ts";
import { makeReadRecoveryHandlers } from "../../app/.server/read-recovery-handlers.ts";

testAgent({ testProvider: {} })("read recovery HTTP boundary", (it) => {
  it.effect(
    "recovery HTTP boundary requires explicit confirmation, same origin and the session lease without executing an agent",
    () =>
      Effect.gen(function* () {
        const context = yield* TestEnv;
        const services = yield* Effect.context<AgentServices>();
        const db = yield* Database;
        const leases = yield* SessionLeases;
        const handlers = makeReadRecoveryHandlers({ runPromise: Effect.runPromiseWith(services) });
        expect(leases.claim(context.session.id, "owning-page")).toEqual({ claimed: true });
        const before = db.sqlite.prepare("SELECT total_changes() AS n").get();
        const params = { session: context.session.id, run: "missing-run" };
        const body = {
          assessmentId: "a".repeat(64),
          confirmation: "confirm_read_only_and_continue_without_replay",
          backup: {
            reference: "isolated-test",
            verification: "operator_verified_consistent_restore",
          },
        };
        for (const entry of [
          { method: "PUT", origin: "http://localhost", holder: "owning-page", body, status: 405 },
          {
            method: "POST",
            origin: "http://evil.example",
            holder: "owning-page",
            body,
            status: 403,
          },
          {
            method: "POST",
            origin: "http://localhost",
            holder: "owning-page",
            body: {},
            status: 400,
          },
          { method: "POST", origin: "http://localhost", holder: "other-page", body, status: 423 },
          { method: "POST", origin: "http://localhost", holder: "owning-page", body, status: 409 },
        ]) {
          const request = new Request("http://localhost/api/sessions/session/read-recovery/run", {
            method: entry.method,
            headers: {
              Origin: entry.origin,
              "X-Session-Holder": entry.holder,
              "Content-Type": "application/json",
            },
            body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(entry.body),
          });
          const response = yield* Effect.promise(() => handlers.action({ request, params }));
          expect(response.status).toBe(entry.status);
        }
        const preview = yield* Effect.promise(() =>
          handlers.loader({ request: new Request("http://localhost"), params }),
        );
        expect(preview.status).toBe(200);
        expect(yield* Effect.promise(() => preview.json())).toEqual({
          type: "blocked",
          reason: "run_not_found",
        });
        expect(db.sqlite.prepare("SELECT total_changes() AS n").get()).toEqual(before);
        expect(context.provider!.adapter.invocations).toHaveLength(0);
      }),
  );
});
