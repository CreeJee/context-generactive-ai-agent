import { Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
import { randomUUID } from "../runtime/synchronous-crypto.ts";
import type { SQLOutputValue } from "node:sqlite";
import { DateTime, Clock, Context, Data, Effect, Layer, Schema } from "effect";
import { Database } from "../db/database.ts";
import { firstMessageTitle } from "./title.ts";
import { Projects } from "../projects/projects.ts";

export const Session = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  /** The external ACP agent this conversation talks to directly; null for the app's own model. */
  agent: Schema.NullOr(Schema.String),
  /** When the user archived it: out of the session list, still part of memory. */
  archivedAt: Schema.NullOr(Schema.String),
  /** The coding agent whose transcript this conversation was migrated from; null for one held here. */
  importedFrom: Schema.NullOr(Schema.String),
  /** The git worktree of the project's repository it ran in; null for the checkout itself. */
  worktreePath: Schema.NullOr(Schema.String),
  /** The branch it ran on, when that was recorded. */
  branch: Schema.NullOr(Schema.String),
});
export type Session = typeof Session.Type;

/** Where in its repository a conversation ran, when that was a worktree or a known branch. */
export interface SessionOrigin {
  readonly worktreePath: string | null;
  readonly branch: string | null;
}

const SessionRow = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  title: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  agent: Schema.NullOr(Schema.String),
  archived_at: Schema.NullOr(Schema.String),
  imported_from: Schema.NullOr(Schema.String),
  worktree_path: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
});
// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const decodeFirstMessage = EffectFunction.flow(
  Schema.decodeUnknownResult(Schema.Struct({ text: Schema.String })),
  Result.getOrThrow,
);
// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const decodeSessionRow = EffectFunction.flow(
  Schema.decodeUnknownResult(SessionRow),
  Result.getOrThrow,
);

function toSession(row: Record<string, SQLOutputValue>): Session {
  const decoded = decodeSessionRow(row);
  return {
    id: decoded.id,
    projectId: decoded.project_id,
    title: decoded.title,
    createdAt: decoded.created_at,
    agent: decoded.agent,
    archivedAt: decoded.archived_at,
    importedFrom: decoded.imported_from,
    worktreePath: decoded.worktree_path,
    branch: decoded.branch,
  };
}

export class SessionNotFound extends Data.TaggedError("SessionNotFound")<{
  readonly id: string;
}> {}

const make = Effect.gen(function* () {
  const effectClock = yield* Clock.Clock;

  const { sqlite } = yield* Database;
  const projects = yield* Projects;
  const firstMessage = sqlite.prepare(
    "SELECT text FROM nodes WHERE session_id = ? AND kind = 'user' ORDER BY seq LIMIT 1",
  );
  // Older local conversations predate automatic title persistence.
  const withTitle = (row: Record<string, SQLOutputValue>): Session => {
    const session = toSession(row);
    if (session.title !== null || session.importedFrom !== null) return session;
    const message = firstMessage.get(session.id);
    return isTruthy(message)
      ? { ...session, title: firstMessageTitle(decodeFirstMessage(message).text) }
      : session;
  };

  return {
    get: (id: string) =>
      Effect.suspend(() => {
        const row = sqlite.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
        return isTruthy(row)
          ? Effect.succeed(withTitle(row))
          : Effect.fail(new SessionNotFound({ id }));
      }),

    /** Fails with ProjectNotFound when the project is not registered. */
    create: (projectId: string, title: string | null = null, agent: string | null = null) =>
      Effect.gen(function* () {
        yield* projects.get(projectId);
        const row = sqlite
          .prepare(
            "INSERT INTO sessions (id, project_id, title, created_at, agent) VALUES (?, ?, ?, ?, ?) RETURNING *",
          )
          .get(
            randomUUID(),
            projectId,
            title,
            DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
            agent,
          );
        if (!isTruthy(row)) return yield* Effect.die(new Error("Session insert returned no row"));
        return toSession(row);
      }),

    /**
     * A conversation migrated from another tool's transcript. It keeps the time that tool started
     * it, so the session list (newest first) puts it where it actually happened.
     */
    createImported: (
      projectId: string,
      title: string | null,
      createdAt: string,
      source: string,
      origin: SessionOrigin,
    ) =>
      Effect.sync(() => {
        const row = sqlite
          .prepare(
            "INSERT INTO sessions (id, project_id, title, created_at, imported_from, worktree_path, branch) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *",
          )
          .get(
            randomUUID(),
            projectId,
            title,
            createdAt,
            source,
            origin.worktreePath,
            origin.branch,
          );
        if (!isTruthy(row)) throw new Error("Session insert returned no row");
        return toSession(row);
      }),

    /** Fills in where a conversation ran once that is known; what is recorded already stays. */
    recordOrigin: (id: string, origin: SessionOrigin) =>
      Effect.sync(() => {
        sqlite
          .prepare(
            "UPDATE sessions SET worktree_path = coalesce(worktree_path, ?), branch = coalesce(branch, ?) WHERE id = ?",
          )
          .run(origin.worktreePath, origin.branch, id);
      }),

    /** Newest first. Archived conversations are listed only when asked for, and then only they are. */
    list: (projectId: string, archived = false) =>
      Effect.sync(() =>
        sqlite
          .prepare(
            `SELECT * FROM sessions WHERE project_id = ? AND archived_at IS ${archived ? "NOT NULL" : "NULL"}
             ORDER BY created_at DESC, id`,
          )
          .all(projectId)
          .map(withTitle),
      ),

    /** Moves a conversation out of the list or back. Messages, memory and search are untouched. */
    setArchived: (id: string, archived: boolean) =>
      Effect.suspend(() => {
        const row = sqlite
          .prepare("UPDATE sessions SET archived_at = ? WHERE id = ? RETURNING *")
          .get(
            archived
              ? DateTime.formatIso(DateTime.makeUnsafe(effectClock.currentTimeMillisUnsafe()))
              : null,
            id,
          );
        return isTruthy(row)
          ? Effect.succeed(withTitle(row))
          : Effect.fail(new SessionNotFound({ id }));
      }),
  };
});

/** Conversations inside a project. Ownership and resume rules arrive with the session phase. */
export class Sessions extends Context.Service<Sessions, Effect.Success<typeof make>>()(
  "memory-agent/sessions/sessions",
) {
  static readonly layer = Layer.effect(Sessions, make);
}
