import { MessageChannel } from "node:worker_threads";
import { once } from "node:events";
import { describe, expect, it } from "vite-plus/test";
import { Effect, Scope, Context, Exit } from "effect";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations } from "../src/db/migrations.ts";
import { makeSqliteOwnerRpcLedger } from "../src/agent/owner-rpc-ledger.ts";
import { makeInMemoryOwnerRpcLedger, type OwnerRpcRequest } from "../src/agent/owner-rpc.ts";
import {
  makeOwnerRpcPortClient,
  serveOwnerRpcPort,
  serveOwnerRpcPortEffect,
} from "../src/agent/owner-rpc-transport.ts";

type Operations = { tool: { input: string; output: string } };
const request = (operationId = 1): OwnerRpcRequest<Operations> => ({
  type: "owner-rpc-request",
  operation: "tool",
  operationId,
  input: "value",
  capability: {
    sessionId: "s",
    runId: "r",
    goalInstanceId: "g",
    goalVersion: 1,
    planVersion: null,
    workflowRevisionId: 1,
    generation: "one",
    token: "secret",
  },
});
function fixture(execute: () => Promise<string> = async () => "done") {
  const { port1, port2 } = new MessageChannel();
  let calls = 0;
  const owner = serveOwnerRpcPort<Operations>(port1, {
    permits: (claim) => claim.token === "secret",
    ledger: makeInMemoryOwnerRpcLedger(),
    handlers: {
      tool: {
        sideEffect: true,
        execute: async () => {
          calls++;
          return execute();
        },
      },
    },
  });
  const client = makeOwnerRpcPortClient<Operations>(port2);
  return {
    client,
    owner,
    calls: () => calls,
    close: () => {
      client.close();
      owner.close();
    },
  };
}

describe("owner MessagePort RPC", () => {
  it("interrupts a native suspended handler on real peer close and preserves durable pending", async () => {
    const dir = mkdtempSync(join(tmpdir(), "port-ledger-"));
    const file = join(dir, "owner.sqlite");
    let sqlite = new DatabaseSync(file);
    for (const migration of migrations) sqlite.exec(migration);
    sqlite.exec(`INSERT INTO projects (id, root, name, created_at) VALUES ('p', '/test', 'test', 'now');
      INSERT INTO sessions (id, project_id, created_at) VALUES ('s', 'p', 'now');
      INSERT INTO workflow_goal_identities VALUES ('s', 'g', 'now');
      INSERT INTO workflow_state_revisions
      (id, session_id, state_json, goal_version, plan_version, provenance, created_at, goal_instance_id)
      VALUES (1, 's', '{}', 1, NULL, 'recorded', 'now', 'g');
      INSERT INTO workflow_run_bindings VALUES ('r', 's', 'g', 1, NULL, 1, 'now');`);
    const ledger = () =>
      makeSqliteOwnerRpcLedger({
        sqlite,
        atomic: (work) => {
          sqlite.exec("BEGIN IMMEDIATE");
          try {
            const result = work();
            sqlite.exec("COMMIT");
            return result;
          } catch (error) {
            sqlite.exec("ROLLBACK");
            throw error;
          }
        },
      });
    const scope = Scope.makeUnsafe();
    const { port1, port2 } = new MessageChannel();
    let started!: () => void;
    let stopped!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const interrupted = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    let calls = 0;
    let replies = 0;
    port2.on("message", () => {
      replies++;
    });
    const endpoint = Effect.runSync(
      Effect.provide(
        serveOwnerRpcPortEffect<Operations>(port1, {
          permits: () => true,
          ledger: ledger(),
          handlers: {
            tool: {
              sideEffect: true,
              execute: () =>
                Effect.sync(() => {
                  calls++;
                  started();
                }).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.sync(stopped))),
            },
          },
        }),
        Context.make(Scope.Scope, scope),
      ),
    );
    try {
      port2.postMessage({ type: "request", requestId: 1, request: request() });
      await ready;
      port2.close();
      await interrupted;
      await Effect.runPromise(endpoint.close);
      expect(port1.listenerCount("message")).toBe(0);
      expect(port1.listenerCount("close")).toBe(0);
      expect(port1.listenerCount("messageerror")).toBe(0);
      expect(replies).toBe(0);
      sqlite.close();
      sqlite = new DatabaseSync(file);
      const { makeOwnerRpc } = await import("../src/agent/owner-rpc.ts");
      const rpc = makeOwnerRpc<Operations>({
        permits: () => true,
        ledger: ledger(),
        handlers: {
          tool: {
            sideEffect: true,
            execute: async () => {
              calls++;
              return "bad";
            },
          },
        },
      });
      expect(await rpc(request())).toEqual({ type: "pending", operationId: 1 });
      expect(await rpc(request(2))).toMatchObject({ reason: "uncertain_run" });
      expect(calls).toBe(1);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      port2.close();
      sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sanitizes acquisition failure and removes partially registered listeners", async () => {
    const { port1, port2 } = new MessageChannel();
    const scope = Scope.makeUnsafe();
    port1.start = () => {
      throw new Error("private-start-secret");
    };
    const acquire = Effect.provide(
      serveOwnerRpcPortEffect<Operations>(port1, {
        permits: () => true,
        ledger: makeInMemoryOwnerRpcLedger(),
        handlers: { tool: { sideEffect: true, execute: () => Effect.succeed("done") } },
      }),
      Context.make(Scope.Scope, scope),
    );
    try {
      const error = await Effect.runPromise(acquire.pipe(Effect.flip));
      expect(error).toMatchObject({
        reason: "protocol",
        message: "Owner RPC transport protocol; dispatched effects may be uncertain",
      });
      expect(JSON.stringify(error)).not.toContain("private-start-secret");
      expect(port1.listenerCount("message")).toBe(0);
      expect(port1.listenerCount("close")).toBe(0);
      expect(port1.listenerCount("messageerror")).toBe(0);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      port2.close();
    }
  });

  it("close before delivery never reserves or dispatches", async () => {
    const { port1, port2 } = new MessageChannel();
    let reservations = 0;
    let calls = 0;
    const base = makeInMemoryOwnerRpcLedger();
    const owner = serveOwnerRpcPort<Operations>(port1, {
      permits: () => true,
      ledger: {
        ...base,
        reserve: (...args) => {
          reservations++;
          return base.reserve(...args);
        },
      },
      handlers: {
        tool: {
          sideEffect: true,
          execute: async () => {
            calls++;
            return "done";
          },
        },
      },
    });
    const closed = once(port2, "close");
    port2.postMessage({ type: "request", requestId: 1, request: request() });
    owner.close();
    await closed;
    expect(reservations).toBe(0);
    expect(calls).toBe(0);
    expect(port1.listenerCount("message")).toBe(0);
  });

  it("sanitizes infrastructure errors and closes without sending raw capabilities", async () => {
    const { port1, port2 } = new MessageChannel();
    let messages = 0;
    port2.on("message", () => {
      messages++;
    });
    const owner = serveOwnerRpcPort<Operations>(port1, {
      permits: () => {
        throw new Error("private-secret-token");
      },
      ledger: makeInMemoryOwnerRpcLedger(),
      handlers: { tool: { sideEffect: true, execute: async () => "done" } },
    });
    const client = makeOwnerRpcPortClient<Operations>(port2);
    try {
      await expect(client.request(request())).rejects.toMatchObject({
        reason: "closed",
        message: "Owner RPC transport closed; dispatched effects may be uncertain",
      });
      expect(messages).toBe(0);
      expect(port1.listenerCount("message")).toBe(0);
    } finally {
      client.close();
      owner.close();
    }
  });
  it("invokes once and replays duplicates through owner ledger", async () => {
    const f = fixture();
    try {
      expect(await f.client.request(request())).toEqual({
        type: "succeeded",
        operationId: 1,
        output: "done",
      });
      expect(await f.client.request(request())).toEqual({
        type: "succeeded",
        operationId: 1,
        output: "done",
      });
      expect(f.calls()).toBe(1);
    } finally {
      f.close();
    }
  });
  it("preserves uncertain effects and never retries", async () => {
    const f = fixture(async () => {
      throw new Error("effect may have happened");
    });
    try {
      expect(await f.client.request(request())).toEqual({ type: "uncertain", operationId: 1 });
      expect(await f.client.request(request())).toEqual({ type: "uncertain", operationId: 1 });
      expect(await f.client.request(request(2))).toEqual({
        type: "rejected",
        operationId: 2,
        reason: "uncertain_run",
      });
      expect(f.calls()).toBe(1);
    } finally {
      f.close();
    }
  });
  it("rejects pending calls on remote closure without retrying dispatched effect", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: (value: string) => void;
    const f = fixture(() => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const result = f.client.request(request());
    const rejected = expect(result).rejects.toMatchObject({ reason: "closed" });
    await ready;
    f.owner.close();
    await rejected;
    finish("done");
    expect(f.calls()).toBe(1);
    f.close();
  });
  it("cancellation rejects locally but allows late settlement without replay", async () => {
    let started!: () => void;
    let finish!: (value: string) => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const f = fixture(() => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    try {
      const controller = new AbortController();
      const mutableRequest = { ...request() };
      const result = f.client.request(mutableRequest, controller.signal);
      // Caller mutation must not change the correlation of the already sent frame.
      mutableRequest.operationId = 999;
      mutableRequest.capability = { ...mutableRequest.capability, token: "changed" };
      const rejected = expect(result).rejects.toMatchObject({ reason: "cancelled" });
      await ready;
      controller.abort();
      await rejected;
      finish("done");
      // FIFO delivery on a real port ensures the late cancelled reply is consumed first.
      expect(await f.client.request(request())).toEqual({
        type: "succeeded",
        operationId: 1,
        output: "done",
      });
      expect(f.calls()).toBe(1);
    } finally {
      f.close();
    }
  });
  it.each([
    null,
    { type: "request", requestId: 1, request: { ...request(), input: undefined } },
    { type: "request", requestId: 1, request: { ...request(), operationId: NaN } },
  ])("fails closed on malformed requests", async (raw) => {
    const { port1, port2 } = new MessageChannel();
    let calls = 0;
    const owner = serveOwnerRpcPort<Operations>(port1, {
      permits: () => true,
      ledger: makeInMemoryOwnerRpcLedger(),
      handlers: {
        tool: {
          sideEffect: true,
          execute: async () => {
            calls++;
            return "done";
          },
        },
      },
    });
    const closed = once(port2, "close");
    port2.postMessage(raw);
    await closed;
    expect(calls).toBe(0);
    owner.close();
  });
  it.each([
    null,
    { type: "reply", requestId: 999, reply: { type: "succeeded", operationId: 1, output: "done" } },
    { type: "reply", requestId: 1, reply: { type: "succeeded", operationId: 2, output: "done" } },
    {
      type: "reply",
      requestId: 1,
      reply: { type: "succeeded", operationId: 1, output: undefined },
    },
  ])("rejects malformed or mismatched replies", async (raw) => {
    const { port1, port2 } = new MessageChannel();
    const client = makeOwnerRpcPortClient<Operations>(port2);
    const result = client.request(request());
    const rejected = expect(result).rejects.toMatchObject({ reason: "protocol" });
    port1.postMessage(raw);
    await rejected;
    client.close();
    port1.close();
  });
});
