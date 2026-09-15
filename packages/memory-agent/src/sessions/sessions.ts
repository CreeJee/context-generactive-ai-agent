import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { Database } from "../db/database.ts";
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
});
export type Session = typeof Session.Type;

const SessionRow = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  title: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  agent: Schema.NullOr(Schema.String),
  archived_at: Schema.NullOr(Schema.String),
});
const decodeSessionRow = Schema.decodeUnknownSync(SessionRow);

function toSession(row: Record<string, SQLOutputValue>): Session {
  const decoded = decodeSessionRow(row);
  return {
    id: decoded.id,
    projectId: decoded.project_id,
    title: decoded.title,
    createdAt: decoded.created_at,
    agent: decoded.agent,
    archivedAt: decoded.archived_at,
  };
}

export class SessionNotFound extends Data.TaggedError("SessionNotFound")<{
  readonly id: string;
}> {}

const make = Effect.gen(function* () {
  const { sqlite } = yield* Database;
  const projects = yield* Projects;

  return {
    get: (id: string) =>
      Effect.suspend(() => {
        const row = sqlite.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
        return row ? Effect.succeed(toSession(row)) : Effect.fail(new SessionNotFound({ id }));
      }),

    /** Fails with ProjectNotFound when the project is not registered. */
    create: (projectId: string, title: string | null = null, agent: string | null = null) =>
      Effect.gen(function* () {
        yield* projects.get(projectId);
        const row = sqlite
          .prepare(
            "INSERT INTO sessions (id, project_id, title, created_at, agent) VALUES (?, ?, ?, ?, ?) RETURNING *",
          )
          .get(randomUUID(), projectId, title, new Date().toISOString(), agent);
        if (!row) return yield* Effect.die(new Error("Session insert returned no row"));
        return toSession(row);
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
          .map(toSession),
      ),

    /** Moves a conversation out of the list or back. Messages, memory and search are untouched. */
    setArchived: (id: string, archived: boolean) =>
      Effect.suspend(() => {
        const row = sqlite
          .prepare("UPDATE sessions SET archived_at = ? WHERE id = ? RETURNING *")
          .get(archived ? new Date().toISOString() : null, id);
        return row ? Effect.succeed(toSession(row)) : Effect.fail(new SessionNotFound({ id }));
      }),
  };
});

/** Conversations inside a project. Ownership and resume rules arrive with the session phase. */
export class Sessions extends Context.Tag("memory-agent/Sessions")<
  Sessions,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.effect(Sessions, make);
}
