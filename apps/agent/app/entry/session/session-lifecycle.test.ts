import { it } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect, vi } from "vite-plus/test";
import { Cause, Effect, Schema } from "effect";
import {
  ApiError,
  ArchiveTaskResult,
  makeSessionLifecycleClient,
  SessionArchiveResult,
  SessionChange,
} from "../api";
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
  worktreePath: null,
  branch: null,
};
const waiting = ArchiveTaskResult.cases.waiting_for_stop.make({
  operationId: "operation-1",
  targetId: session.id,
});
const blocked = ArchiveTaskResult.cases.blocked.make({ blocker: "live_attempt" });
const completed = ArchiveTaskResult.cases.completed.make({ targetId: session.id });
const actions = [
  {
    name: "archive",
    invoke: () => api.setArchived(session.id, "holder-1", true),
    change: (idempotencyKey: string) => SessionChange.Archive({ archived: true, idempotencyKey }),
  },
  {
    name: "restore",
    invoke: () => api.setArchived(session.id, "holder-1", false),
    change: (idempotencyKey: string) => SessionChange.Archive({ archived: false, idempotencyKey }),
  },
  {
    name: "delete",
    invoke: () => api.deleteSession(session.id, "holder-1"),
    change: (idempotencyKey: string) => SessionChange.Delete({ idempotencyKey }),
  },
];

type LifecycleFixture = Record<string, string | null>;

function respond(body: LifecycleFixture, status = 200) {
  appFetch.mockResolvedValueOnce(Response.json(body, { status }));
}

// The client resolves the API's paths against the page, as in the browser.
beforeEach(() => vi.stubGlobal("location", new URL("http://app.test/")));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

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
        expect(yield* call(() => api.setArchived(session.id, "holder-1", archived))).toEqual(
          SessionArchiveResult.completed({ session: snapshot }),
        );
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
        const [url, init] = appFetch.mock.calls[0] ?? [];
        expect(new Request(url ?? "").url).toBe("http://app.test/api/sessions/session%2F1");
        expect(init).toMatchObject({
          method: "POST",
          headers: { "x-session-holder": "holder-1", "content-type": "application/json" },
        });
        const body = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
        )(yield* Effect.promise(() => new Response(init?.body).text()));
        const idempotencyKey = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(
          body.idempotencyKey,
        );
        expect(body).toEqual(change(idempotencyKey));
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
          expect((yield* Effect.flip(call(() => invoke()))).cause).toBeInstanceOf(ApiError);
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
