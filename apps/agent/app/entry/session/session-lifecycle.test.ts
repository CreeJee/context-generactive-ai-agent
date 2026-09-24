import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { sessionHolderHeader } from "memory-agent/definitions";
import { Schema } from "effect";
import { api, ApiError } from "../api";
import { appFetch } from "../shared/backend-restart";

vi.mock("../shared/backend-restart", () => ({ appFetch: vi.fn() }));

const session = {
  id: "session/1",
  projectId: "project-1",
  title: "Conversation",
  createdAt: "2026-09-24",
  agent: null,
  archivedAt: "2026-09-24",
  importedFrom: null,
};
const waiting = {
  status: "waiting_for_stop",
  operationId: "operation-1",
  targetId: session.id,
};
const blocked = { status: "blocked", blocker: "live_attempt" };
const completed = { status: "completed", targetId: session.id };
const actions = [
  {
    name: "archive",
    invoke: () => api.setArchived(session.id, "holder-1", true),
    change: { archived: true },
  },
  {
    name: "restore",
    invoke: () => api.setArchived(session.id, "holder-1", false),
    change: { archived: false },
  },
  {
    name: "delete",
    invoke: () => api.deleteSession(session.id, "holder-1"),
    change: { delete: true },
  },
];

type LifecycleFixture = Record<string, string | null>;

function respond(body: LifecycleFixture, status = 200) {
  vi.mocked(appFetch).mockResolvedValueOnce(Response.json(body, { status }));
}

afterEach(() => vi.resetAllMocks());

describe("server-authoritative session lifecycle client", () => {
  test.each([true, false])(
    "normalizes completed archive=%s with its session snapshot",
    async (archived) => {
      const snapshot = { ...session, archivedAt: archived ? session.archivedAt : null };
      respond(snapshot);
      await expect(api.setArchived(session.id, "holder-1", archived)).resolves.toEqual({
        status: "completed",
        session: snapshot,
      });
    },
  );

  test("preserves completed deletion", async () => {
    respond(completed);
    await expect(api.deleteSession(session.id, "holder-1")).resolves.toEqual(completed);
  });

  describe.each(actions)("$name", ({ invoke, change }) => {
    test("preserves HTTP 202 waiting instead of reporting completion", async () => {
      respond(waiting, 202);
      await expect(invoke()).resolves.toEqual(waiting);
      expect(appFetch).toHaveBeenCalledWith("/api/sessions/session%2F1", {
        method: "POST",
        headers: { [sessionHolderHeader]: "holder-1", "Content-Type": "application/json" },
        body: expect.any(String),
      });
      const requestBody = vi.mocked(appFetch).mock.calls[0]?.[1]?.body;
      const body = JSON.parse(Schema.decodeUnknownSync(Schema.String)(requestBody));
      expect(body).toEqual({ ...change, idempotencyKey: expect.any(String) });
      expect(body.idempotencyKey).not.toBe("");
    });

    test.each([202, 409])("preserves HTTP %s blocked as an expected result", async (status) => {
      respond(blocked, status);
      await expect(invoke()).resolves.toEqual(blocked);
    });

    test("keeps lease failures as errors", async () => {
      respond({ error: "session_in_use" }, 423);
      await expect(invoke()).rejects.toMatchObject({ status: 423, code: "session_in_use" });
    });

    test.each([session, completed, {}])(
      "does not trust a completion-shaped HTTP 202 body: %j",
      async (body) => {
        respond(body, 202);
        await expect(invoke()).rejects.toMatchObject({ status: 502, code: "request_failed" });
      },
    );

    test("rejects malformed success responses", async () => {
      respond({});
      await expect(invoke()).rejects.toBeInstanceOf(ApiError);
    });
  });
});
