import { Array as Arr, Context, Data, Effect, Layer, Match, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import type { RunHook } from "../loop/run.ts";

/**
 * Conversations the user linked in their own messages (docs/decisions.md 2026-11-24 "사용자가 붙인
 * 대화 링크는 그 대화 하나만 연다"). The app opens a conversation at `?project=<id>&session=<id>`.
 * A link the user pasted is consent to read that one conversation: the linking conversation's runs
 * are told what it holds, and read_evidence and trace_evidence read its messages even when recall
 * across projects is off. find_memory does not search it. A project excluded from recall across
 * projects stays closed.
 */

/** Links one conversation follows, the first ones the user pasted. */
export const maxLinkedSessions = 4;
/** Messages of a linked conversation listed for the model: its latest ones. */
export const linkedMessageLimit = 24;
const snippetCharacters = 200;

/** A conversation of the app, as its link names it. */
export interface SessionLink {
  readonly projectId: string;
  readonly sessionId: string;
}

/** A message of a linked conversation, listed so the model can read it by its node id. */
export interface LinkedMessage {
  readonly id: string;
  readonly kind: "user" | "assistant";
  readonly snippet: string;
}

export type LinkedSession = Data.TaggedEnum<{
  /** Readable: its latest messages, oldest first, and how many it holds in all. */
  Open: {
    readonly link: SessionLink;
    readonly projectName: string;
    readonly title: string | null;
    readonly messages: ReadonlyArray<LinkedMessage>;
    readonly total: number;
  };
  /** Its project is excluded from recall across projects, so it stays closed. */
  Closed: { readonly link: SessionLink; readonly projectName: string };
  /** No such conversation in the project the link names. */
  Unknown: { readonly link: SessionLink };
}>;
export const LinkedSession = Data.taggedEnum<LinkedSession>();

const urlPattern = /https?:\/\/[^\s<>"'`()[\]]+/g;
const urlOf = Option.liftThrowable((value: string) => new URL(value));
const paramOf = (url: URL, name: string) =>
  Option.filter(Option.fromNullishOr(url.searchParams.get(name)), (value) => value.length > 0);

/** The app conversation links in `texts`, in order, each conversation once. */
export const sessionLinksIn = (texts: ReadonlyArray<string>): ReadonlyArray<SessionLink> =>
  Arr.dedupeWith(
    texts.flatMap((text) =>
      (text.match(urlPattern) ?? []).flatMap((raw) =>
        Option.toArray(
          // A sentence's last mark is not part of the link.
          Option.flatMap(urlOf(raw.replace(/[.,;:!?]+$/, "")), (url) =>
            Option.all({ projectId: paramOf(url, "project"), sessionId: paramOf(url, "session") }),
          ),
        ),
      ),
    ),
    (left, right) => left.sessionId === right.sessionId,
  );

/** The ids of the linked conversations the memory tools may read. */
export const readableSessions = (linked: ReadonlyArray<LinkedSession>) =>
  linked.flatMap((session) => (LinkedSession.$is("Open")(session) ? [session.link.sessionId] : []));

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, snippetCharacters);

/** What the model is told of the linked conversations. */
export const linkedSessionsText = (linked: ReadonlyArray<LinkedSession>) =>
  [
    "Conversations the user linked in this conversation. A link with ?project=…&session=… opens a conversation of this app: it is not a file, a design or a web page. Read a listed message with read_evidence by its id; trace_evidence follows it back to its cause. find_memory does not search these conversations.",
    ...linked.map(
      LinkedSession.$match({
        Open: ({ link, projectName, title, messages, total }) =>
          [
            `- Conversation ${link.sessionId}${title === null ? "" : ` "${oneLine(title)}"`} in project ${projectName} (${link.projectId}): ${total} messages${messages.length < total ? `, the latest ${messages.length} listed` : ""}, oldest first:`,
            ...messages.map((message) => `  - ${message.kind} ${message.id}: ${message.snippet}`),
          ].join("\n"),
        Closed: ({ link, projectName }) =>
          `- Conversation ${link.sessionId} in project ${projectName}: the user excluded that project from memory shared across projects, so it cannot be read. Tell the user.`,
        Unknown: ({ link }) =>
          `- Conversation ${link.sessionId}: no such conversation in project ${link.projectId}. Ask the user for the right link.`,
      }),
    ),
  ].join("\n");

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const linkingTexts = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ text: Schema.String }),
    execute: (sessionId) => sql`SELECT text FROM nodes
      WHERE session_id = ${sessionId} AND kind = 'user' AND instr(text, 'session=') > 0
      ORDER BY seq`,
  });
  const sessionOf = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({
      project_id: Schema.String,
      title: Schema.NullOr(Schema.String),
      project_name: Schema.String,
      cross_recall_excluded: Schema.Finite,
    }),
    execute: (sessionId) => sql`SELECT s.project_id, s.title, p.name AS project_name,
        p.cross_recall_excluded
      FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ${sessionId}`,
  });
  // The count is over every message, taken before the limit.
  const latestMessages = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({
      id: Schema.String,
      kind: Schema.Literals(["user", "assistant"]),
      text: Schema.String,
      total: Schema.Finite,
    }),
    execute: (sessionId) => sql`SELECT id, kind, text, count(*) OVER () AS total FROM nodes
      WHERE session_id = ${sessionId} AND kind IN ('user', 'assistant') AND text <> ''
      ORDER BY seq DESC LIMIT ${linkedMessageLimit}`,
  });

  const resolve = (projectId: string, link: SessionLink) =>
    Effect.flatMap(
      sessionOf(link.sessionId),
      Option.match({
        onNone: () => Effect.succeed(LinkedSession.Unknown({ link })),
        onSome: (row) =>
          Match.value(row).pipe(
            Match.when({ project_id: (id) => id !== link.projectId }, () =>
              Effect.succeed(LinkedSession.Unknown({ link })),
            ),
            Match.when({ project_id: (id) => id !== projectId, cross_recall_excluded: 1 }, () =>
              Effect.succeed(LinkedSession.Closed({ link, projectName: row.project_name })),
            ),
            Match.orElse(() =>
              Effect.map(latestMessages(link.sessionId), (rows) =>
                LinkedSession.Open({
                  link,
                  projectName: row.project_name,
                  title: row.title,
                  messages: rows
                    .map(({ id, kind, text }) => ({ id, kind, snippet: oneLine(text) }))
                    .reverse(),
                  total: rows[0]?.total ?? 0,
                }),
              ),
            ),
          ),
      }),
    );

  return {
    /** The conversations the user linked in `sessionId`'s messages, other than itself. */
    linked: Effect.fn("LinkedSessions.linked")(function* (projectId: string, sessionId: string) {
      const links = sessionLinksIn((yield* linkingTexts(sessionId)).map((row) => row.text))
        .filter((link) => link.sessionId !== sessionId)
        .slice(0, maxLinkedSessions);
      return yield* Effect.forEach(links, (link) => resolve(projectId, link));
    }),

    /**
     * Tells each request of a run the linked conversations, after the system prompts the hooks
     * before this one chose. `linked` is read once for the run, so its prompt stays the same.
     */
    hookFor: (linked: Effect.Effect<ReadonlyArray<LinkedSession>>): RunHook => ({
      request: (_scope, request) =>
        Effect.map(linked, (sessions) =>
          sessions.length === 0
            ? request
            : { ...request, system: [...request.system, linkedSessionsText(sessions)] },
        ),
    }),
  };
});

export class LinkedSessions extends Context.Service<LinkedSessions, Effect.Success<typeof make>>()(
  "memory-agent/memory/linked-sessions/LinkedSessions",
) {
  static readonly layer = Layer.effect(LinkedSessions, make);
}
