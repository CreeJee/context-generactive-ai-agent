import { describe, expect, it } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  resumeServerSentEventsResponse,
  toServerSentEventsResponse,
  type StreamChunk,
} from "@tanstack/ai";
import { sqliteStreamDurability } from "./durable-stream.ts";
import { migrations } from "../db/migrations.ts";

function owner(path: string) {
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA foreign_keys = ON");
  if (!sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'projects'").get()) {
    for (const migration of migrations) sqlite.exec(migration);
    sqlite.exec(`
      INSERT INTO projects (id, root, name, created_at) VALUES ('project', '/test', 'test', 'now');
      INSERT INTO sessions (id, project_id, created_at) VALUES ('session', 'project', 'now');
      INSERT INTO workflow_goal_identities VALUES ('session', 'goal', 'now');
      INSERT INTO workflow_state_revisions
        (session_id, state_json, goal_version, plan_version, provenance, created_at, goal_instance_id)
        VALUES ('session', '{}', 1, NULL, 'recorded', 'now', 'goal');
      INSERT INTO workflow_run_bindings VALUES ('run', 'session', 'goal', 1, NULL, 1, 'now');
    `);
  }
  return {
    sqlite,
    atomic: <T>(work: () => T): T => {
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
    sessionId: "session",
    runId: "run",
  };
}
// SAFETY: both lifecycle fixtures provide required runId/threadId; literal tags match SDK enum wire values.
const chunk = (type: "RUN_STARTED" | "RUN_FINISHED", runId = "run"): StreamChunk =>
  ({ type, runId, threadId: "session", timestamp: 1 }) as StreamChunk;

describe("central SQLite SDK durability", () => {
  it("validates binding, minted offsets, atomic batches, snapshot and close", async () => {
    const db = owner(":memory:");
    try {
      const adapter = sqliteStreamDurability(db);
      expect(await adapter.snapshot()).toEqual([]);
      expect(() => sqliteStreamDurability({ ...db, sessionId: "other" })).toThrow();
      await expect(
        adapter.append([chunk("RUN_STARTED"), chunk("RUN_FINISHED", "other")]),
      ).rejects.toThrow();
      expect(await adapter.snapshot()).toEqual([]);
      const [offset] = await adapter.append([chunk("RUN_STARTED")]);
      expect(() => sqliteStreamDurability({ ...db, resumeOffset: "1" })).toThrow();
      expect(() =>
        sqliteStreamDurability({ ...db, resumeOffset: "sdk-stream:v1:other:1" }),
      ).toThrow();
      const snapshot = await adapter.snapshot();
      snapshot[0]!.chunk.timestamp = 999;
      expect((await adapter.snapshot())[0]!.chunk.timestamp).toBe(1);
      await adapter.close();
      await adapter.close();
      await expect(adapter.append([chunk("RUN_FINISHED")])).rejects.toThrow();
      const replay = [];
      for await (const entry of adapter.read("-1")) replay.push(entry);
      expect(replay.map((entry) => entry.offset)).toEqual([offset]);
    } finally {
      db.sqlite.close();
    }
  });

  it("tails across owner adapters and aborts open logs without terminalizing them", async () => {
    const db = owner(":memory:");
    try {
      const reader = sqliteStreamDurability(db);
      const abort = new AbortController();
      const iterator = reader.read("-1", abort.signal)[Symbol.asyncIterator]();
      const next = iterator.next();
      await sqliteStreamDurability(db).append([chunk("RUN_STARTED")]);
      expect((await next).value?.chunk.type).toBe("RUN_STARTED");
      const pending = iterator.next();
      abort.abort();
      expect((await pending).done).toBe(true);
      await reader.append([chunk("RUN_FINISHED")]);
    } finally {
      db.sqlite.close();
    }
  });

  it("serves real SDK SSE over HTTP and replays persisted offsets after owner DB restart without running a producer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sdk-durable-"));
    const path = join(directory, "owner.sqlite");
    let db = owner(path);
    let producerCalls = 0;
    const server = createServer(async (request, response) => {
      try {
        const offset = request.headers["last-event-id"];
        const adapter = sqliteStreamDurability({
          ...db,
          resumeOffset: Array.isArray(offset) ? (offset[0] ?? null) : (offset ?? null),
        });
        async function* produce() {
          producerCalls++;
          yield chunk("RUN_STARTED");
          yield chunk("RUN_FINISHED");
        }
        const result =
          request.url === "/resume"
            ? resumeServerSentEventsResponse({ adapter })
            : toServerSentEventsResponse(produce(), { durability: { adapter } });
        response.writeHead(result.status, Object.fromEntries(result.headers));
        for await (const bytes of result.body!) response.write(bytes);
        response.end();
      } catch {
        response.writeHead(400);
        response.end();
      }
    });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      // SAFETY: listen(0, IPv4 host) selected TCP, and the listening event has fired.
      const address = server.address() as import("node:net").AddressInfo;
      const url = `http://127.0.0.1:${address.port}`;
      const live = await (await fetch(url)).text();
      const ids = [...live.matchAll(/^id: (.+)$/gm)].map((match) => match[1]!);
      expect(ids).toHaveLength(3); // SDK inserts a persisted RUN_ACCEPTED CUSTOM event.
      expect(ids.every((id) => id.startsWith("sdk-stream:v1:run:"))).toBe(true);
      db.sqlite.close();
      db = owner(path);
      const replay = await (
        await fetch(`${url}/resume`, { headers: { "Last-Event-ID": ids[1]! } })
      ).text();
      expect(replay).not.toContain("RUN_STARTED");
      expect(replay).toContain("RUN_FINISHED");
      expect(replay).toContain(`id: ${ids[2]}`);
      expect(producerCalls).toBe(1);
      expect(
        (await fetch(`${url}/resume`, { headers: { "Last-Event-ID": "forged" } })).status,
      ).toBe(400);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
