import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { Clock, Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { SqlClient, SqlError, SqlSchema } from "effect/sql";
import { firstMessageTitle } from "./title.ts";
import { Projects } from "../projects/projects.ts";
import { Session } from "./contracts.ts";

export { Session } from "./contracts.ts";

/** The other tool's transcript a conversation was imported from. */
export interface ImportedTranscript {
  readonly source: string;
  readonly externalId: string;
}

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
function toSession(row: typeof SessionRow.Type): Session {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    createdAt: row.created_at,
    agent: row.agent,
    archivedAt: row.archived_at,
    importedFrom: row.imported_from,
    worktreePath: row.worktree_path,
    branch: row.branch,
  };
}

export class SessionNotFound extends Schema.TaggedError<
  SessionNotFound,
  { readonly brand: unique symbol }
>()("SessionNotFound", {
  id: Schema.String,
}) {}

const NewSession = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  agent: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* SecureRandom.SecureRandom;
  const projects = yield* Projects;
  const isoNow = Effect.map(Clock.currentTimeMillis, (millis) =>
    DateTime.formatIso(DateTime.makeUnsafe(millis)),
  );
  const firstMessage = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ text: Schema.String }),
    execute: (sessionId) => sql`
      SELECT text FROM nodes WHERE session_id = ${sessionId} AND kind = 'user'
      ORDER BY seq LIMIT 1`,
  });
  // Older local conversations predate automatic title persistence.
  const withTitle = (
    row: typeof SessionRow.Type,
  ): Effect.Effect<Session, SqlError.SqlError | Schema.SchemaError> => {
    const session = toSession(row);
    if (session.title !== null || session.importedFrom !== null) return Effect.succeed(session);
    return Effect.map(firstMessage(session.id), (message) =>
      Option.match(message, {
        onNone: () => session,
        onSome: ({ text }) => ({ ...session, title: firstMessageTitle(text) }),
      }),
    );
  };
  const found =
    (id: string) =>
    (
      row: Option.Option<typeof SessionRow.Type>,
    ): Effect.Effect<Session, SessionNotFound | SqlError.SqlError | Schema.SchemaError> =>
      Option.match(row, {
        onNone: () => Effect.fail(SessionNotFound.make({ id })),
        onSome: withTitle,
      });
  /** A session row with the source its transcript mapping names, if it was imported. */
  const columns = sql`sessions.id, sessions.project_id, sessions.title, sessions.created_at,
    sessions.agent, sessions.archived_at,
    (SELECT i.source FROM imported_sessions i WHERE i.session_id = sessions.id) AS imported_from,
    sessions.worktree_path, sessions.branch`;
  const byId = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: SessionRow,
    execute: (id) => sql`SELECT ${columns} FROM sessions WHERE id = ${id}`,
  });
  const insert = SqlSchema.findOne({
    Request: NewSession,
    Result: SessionRow,
    execute: (row) => sql`
      INSERT INTO sessions (id, project_id, title, created_at, agent, worktree_path, branch)
      VALUES (${row.id}, ${row.projectId}, ${row.title}, ${row.createdAt}, ${row.agent},
        ${row.worktreePath}, ${row.branch})
      RETURNING ${columns}`,
  });
  const list = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: Schema.String, archived: Schema.Boolean }),
    Result: SessionRow,
    execute: ({ projectId, archived }) => sql`
      SELECT ${columns} FROM sessions
      WHERE project_id = ${projectId} AND parent_session_id IS NULL
        AND archived_at IS ${sql.literal(archived ? "NOT NULL" : "NULL")}
      ORDER BY created_at DESC, id`,
  });
  const archive = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: Schema.String, archivedAt: Schema.NullOr(Schema.String) }),
    Result: SessionRow,
    execute: ({ id, archivedAt }) =>
      sql`UPDATE sessions SET archived_at = ${archivedAt} WHERE id = ${id} RETURNING ${columns}`,
  });

  return {
    get: (id: string) => Effect.flatMap(byId(id), found(id)),

    /** Fails with ProjectNotFound when the project is not registered. */
    create: (projectId: string, title: string | null = null, agent: string | null = null) =>
      Effect.gen(function* () {
        yield* projects.get(projectId);
        const row = yield* insert({
          id: yield* crypto.uuidV4(),
          projectId,
          title,
          createdAt: yield* isoNow,
          agent,
          worktreePath: null,
          branch: null,
        });
        return toSession(row);
      }),

    /**
     * A conversation migrated from another tool's transcript. It keeps the time that tool started
     * it, so the session list (newest first) puts it where it actually happened. The transcript's
     * mapping is written with it, so a rescan finds this session instead of starting another.
     */
    createImported: (
      projectId: string,
      title: string | null,
      createdAt: string,
      transcript: ImportedTranscript,
      origin: SessionOrigin,
    ) =>
      Effect.gen(function* () {
        const row = yield* insert({
          id: yield* crypto.uuidV4(),
          projectId,
          title,
          createdAt,
          agent: null,
          worktreePath: origin.worktreePath,
          branch: origin.branch,
        });
        yield* sql`INSERT INTO imported_sessions (source, external_id, session_id)
          VALUES (${transcript.source}, ${transcript.externalId}, ${row.id})`;
        return toSession({ ...row, imported_from: transcript.source });
      }).pipe(sql.withTransaction),

    /** Fills in where a conversation ran once that is known; what is recorded already stays. */
    recordOrigin: (id: string, origin: SessionOrigin) =>
      Effect.asVoid(sql`
        UPDATE sessions SET worktree_path = coalesce(worktree_path, ${origin.worktreePath}),
          branch = coalesce(branch, ${origin.branch})
        WHERE id = ${id}`),

    /**
     * Newest first. Archived conversations are listed only when asked for, and then only they are.
     * A subagent's session is shown with the session that started it, not here.
     */
    list: (projectId: string, archived = false) =>
      Effect.flatMap(list({ projectId, archived }), (rows) => Effect.forEach(rows, withTitle)),

    /** Moves a conversation out of the list or back. Messages, memory and search are untouched. */
    setArchived: (id: string, archived: boolean) =>
      Effect.gen(function* () {
        const row = yield* archive({ id, archivedAt: archived ? yield* isoNow : null });
        return yield* found(id)(row);
      }),
  };
});

/** Conversations inside a project. Ownership and resume rules arrive with the session phase. */
export class Sessions extends Context.Service<Sessions, Effect.Success<typeof make>>()(
  "memory-agent/sessions/sessions",
) {
  static readonly layer = Layer.effect(Sessions, make).pipe(Layer.provide(NodeCrypto.layer));
}
