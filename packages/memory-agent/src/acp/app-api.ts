import type { UIMessage } from "@tanstack/ai-client";
import { Data, Either, ParseResult, Schema } from "effect";
import { sessionHolderHeader } from "../sessions/lease-state.ts";

/** Where the running app is, unless `CONTEXT_AGENT_URL` says otherwise. */
export const defaultAppUrl = "http://127.0.0.1:5173";

const ProjectSummary = Schema.Struct({
  id: Schema.String,
  root: Schema.String,
  name: Schema.String,
});
const SessionSummary = Schema.Struct({ id: Schema.String, projectId: Schema.String });
const AuthSummary = Schema.Struct({ status: Schema.String });
const LeaseSummary = Schema.Struct({ state: Schema.Literal("mine", "other", "free") });
const RunSummary = Schema.Struct({
  running: Schema.NullOr(Schema.Struct({ runId: Schema.String })),
  lease: LeaseSummary,
});
const ErrorBody = Schema.Struct({ error: Schema.String });

/** Request bodies the bridge sends: flat JSON objects. */
type JsonBody = Readonly<Record<string, string | boolean>>;

export type ProjectSummary = typeof ProjectSummary.Type;
export type SessionSummary = typeof SessionSummary.Type;

/** The app answered with an error, or could not be reached (`unreachable`). */
export class AppRequestFailed extends Data.TaggedError("AppRequestFailed")<{
  readonly status: number;
  readonly code: string;
  readonly message: string;
}> {
  constructor(status: number, code: string) {
    super({ status, code, message: `${code} (${status})` });
  }
}

/**
 * The app's HTTP API as the ACP bridge uses it. The bridge owns no storage: the app process
 * keeps the database, the vector index and the ChatGPT connection, so sessions started from an
 * editor are the same sessions the web page shows.
 */
export function createAppApi(baseUrl: string, fetcher: typeof fetch = fetch) {
  const call = async <A, I>(
    schema: Schema.Schema<A, I>,
    path: string,
    init: RequestInit = {},
  ): Promise<A> => {
    let response: Response;
    try {
      response = await fetcher(`${baseUrl}${path}`, init);
    } catch {
      throw new AppRequestFailed(0, "unreachable");
    }
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code = Schema.decodeUnknownEither(ErrorBody)(json);
      throw new AppRequestFailed(
        response.status,
        Either.match(code, {
          onLeft: () => "request_failed",
          onRight: (body) => body.error,
        }),
      );
    }
    return Either.getOrElse(Schema.decodeUnknownEither(schema)(json), (error) => {
      throw new AppRequestFailed(
        response.status,
        `unexpected_response: ${ParseResult.TreeFormatter.formatErrorSync(error).split("\n")[0]}`,
      );
    });
  };

  const post = (body: JsonBody, holder?: string): RequestInit => {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (holder) headers.set(sessionHolderHeader, holder);
    return { method: "POST", headers, body: JSON.stringify(body) };
  };

  return {
    baseUrl,
    fetcher,

    auth: () => call(AuthSummary, "/api/auth"),

    projects: () => call(Schema.Array(ProjectSummary), "/api/projects"),

    createSession: (projectId: string, title: string) =>
      call(SessionSummary, "/api/sessions", post({ projectId, title })),

    sessionState: (sessionId: string, holder: string) =>
      call(
        RunSummary,
        `/api/sessions/${encodeURIComponent(sessionId)}?holder=${encodeURIComponent(holder)}`,
      ),

    lease: (sessionId: string, holder: string, action: "claim" | "release") =>
      call(
        LeaseSummary,
        `/api/sessions/${encodeURIComponent(sessionId)}/lease`,
        post({ holder, action }),
      ),

    cancel: (sessionId: string, holder: string) =>
      call(
        Schema.Unknown,
        `/api/sessions/${encodeURIComponent(sessionId)}/cancel`,
        post({}, holder),
      ),

    /** The saved conversation, as a reloaded page gets it. */
    transcript: async (sessionId: string): Promise<UIMessage[]> => {
      const body = await call(
        Schema.Struct({ messages: Schema.Array(Schema.Unknown) }),
        `/api/chat?session=${encodeURIComponent(sessionId)}&threadId=${encodeURIComponent(sessionId)}`,
      );
      // SAFETY: the app serializes UIMessage values it built itself; the bridge only reads roles,
      // text and tool parts from them and ignores anything else.
      return body.messages as UIMessage[];
    },

    /** Calls of subagents and external agents waiting for the user. */
    approvals: (sessionId: string) =>
      call(
        Schema.Array(
          Schema.Struct({
            id: Schema.String,
            requester: Schema.Union(
              Schema.Struct({
                kind: Schema.Literal("subagent"),
                subagentId: Schema.String,
                name: Schema.NullOr(Schema.String),
              }),
              Schema.Struct({ kind: Schema.Literal("external_agent"), agent: Schema.String }),
            ),
            toolName: Schema.String,
            argumentsJson: Schema.String,
          }),
        ),
        `/api/sessions/${encodeURIComponent(sessionId)}/approvals`,
      ),

    answerApproval: (sessionId: string, holder: string, approvalId: string, approved: boolean) =>
      call(
        Schema.Unknown,
        `/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
        post({ approved }, holder),
      ),

    chatUrl: (sessionId: string) => `${baseUrl}/api/chat?session=${encodeURIComponent(sessionId)}`,
  };
}

export type AppApi = ReturnType<typeof createAppApi>;
