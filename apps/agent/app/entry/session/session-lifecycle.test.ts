import { it } from "@effect/vitest";
import { afterEach, describe, expect, vi } from "vite-plus/test";
import { sessionHolderHeader } from "memory-agent/definitions";
import { Cause, Effect, Schema } from "effect";
import { makeSessionLifecycleClient, ApiError } from "../api";
const appFetch = vi.fn<typeof fetch>();
const api = makeSessionLifecycleClient(appFetch);

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
  appFetch.mockResolvedValueOnce(Response.json(body, { status }));
}

afterEach(() => vi.resetAllMocks());

const call = <P extends Promise<unknown>>(execute: () => P) =>
  Effect.tryPromise({
    try: () => Promise.resolve(execute()),
    catch: (cause) => new Cause.UnknownError(cause),
  });

describe("server-authoritative session lifecycle client", () => {
  it.effect.each([true, false])(
    "normalizes completed archive=%s with its session snapshot",
    (archived) =>
      Effect.gen(function* () {
        const snapshot = { ...session, archivedAt: archived ? session.archivedAt : null };
        respond(snapshot);
        expect(yield* call(() => api.setArchived(session.id, "holder-1", archived))).toEqual({
          status: "completed",
          session: snapshot,
        });
      }),
  );

  it.effect("preserves completed deletion", () =>
    Effect.gen(function* () {
      respond(completed);
      expect(yield* call(() => api.deleteSession(session.id, "holder-1"))).toEqual(completed);
    }),
  );

  describe.each(actions)("$name", ({ invoke, change }) => {
    it.effect("preserves HTTP 202 waiting instead of reporting completion", () =>
      Effect.gen(function* () {
        respond(waiting, 202);
        expect(yield* call(() => invoke())).toEqual(waiting);
        expect(appFetch).toHaveBeenCalledWith("/api/sessions/session%2F1", {
          method: "POST",
          headers: { [sessionHolderHeader]: "holder-1", "Content-Type": "application/json" },
          body: expect.any(String),
        });
        const requestBody = appFetch.mock.calls[0]?.[1]?.body;
        const body = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
        )(requestBody);
        expect(body).toEqual({ ...change, idempotencyKey: expect.any(String) });
        expect(body.idempotencyKey).not.toBe("");
      }),
    );

    it.effect.each([202, 409])("preserves HTTP %s blocked as an expected result", (status) =>
      Effect.gen(function* () {
        respond(blocked, status);
        expect(yield* call(() => invoke())).toEqual(blocked);
      }),
    );

    it.effect("keeps lease failures as errors", () =>
      Effect.gen(function* () {
        respond({ error: "session_in_use" }, 423);
        expect((yield* Effect.flip(call(() => invoke()))).cause).toMatchObject({
          status: 423,
          code: "session_in_use",
        });
      }),
    );

    it.effect.each([session, completed, {}])(
      "does not trust a completion-shaped HTTP 202 body: %j",
      (body) =>
        Effect.gen(function* () {
          respond(body, 202);
          expect((yield* Effect.flip(call(() => invoke()))).cause).toMatchObject({
            status: 502,
            code: "request_failed",
          });
        }),
    );

    it.effect("rejects malformed success responses", () =>
      Effect.gen(function* () {
        respond({});
        expect((yield* Effect.flip(call(() => invoke()))).cause).toBeInstanceOf(ApiError);
      }),
    );
  });
});
