import { isTruthy } from "../truthy.ts";
import { Effect, Function as EffectFunction, Result, Schema } from "effect";
import { sessionHolderHeader } from "../sessions/lease-state.ts";
import { ApprovalRequester } from "../approvals/relayed-state.ts";

/** Where the running app is, unless `CONTEXT_AGENT_URL` says otherwise. */
export const defaultAppUrl = "http://127.0.0.1:5173";

const ProjectSummary = Schema.Struct({
  id: Schema.String,
  root: Schema.String,
  name: Schema.String,
});
const SessionSummary = Schema.Struct({ id: Schema.String, projectId: Schema.String });
/** The case of the app's provider connection; the bridge needs only whether it is signed in. */
export const AuthSummary = Schema.TaggedUnion({
  "signed-out": {},
  pending: {},
  "signed-in": {},
  error: {},
});
const LeaseSummary = Schema.Struct({ state: Schema.Literals(["mine", "other", "free"]) });
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
export const AppRequestReason = Schema.TaggedUnion({
  TransportFailed: {},
  RequestRejected: {},
  InvalidResponse: {},
});

export class AppRequestFailed extends Schema.TaggedError<AppRequestFailed>()("AppRequestFailed", {
  status: Schema.Finite,
  code: Schema.String,
  message: Schema.String,
  reason: AppRequestReason,
}) {}

/** The app refused a request with `code`, or could not be reached (`unreachable`, status 0). */
export const requestFailure = ({
  status,
  code,
  reason,
}: {
  readonly status: number;
  readonly code: string;
  readonly reason: keyof typeof AppRequestReason.cases;
}) =>
  AppRequestFailed.make({
    status,
    code,
    message: `${code} (${status})`,
    reason: AppRequestReason.cases[reason].make({}),
  });

/**
 * The app's HTTP API as the ACP bridge uses it. The bridge owns no storage: the app process
 * keeps the database, the vector index and the ChatGPT connection, so sessions started from an
 * editor are the same sessions the web page shows.
 */
export const createAppApi: {
  (baseUrl: string): ReturnType<typeof createAppApiBody>;
  (baseUrl: string, fetcher: typeof fetch): ReturnType<typeof createAppApiBody>;
  (fetcher: typeof fetch): (baseUrl: string) => ReturnType<typeof createAppApiBody>;
} = EffectFunction.dual((args) => Schema.is(Schema.String)(args[0]), createAppApiBody);
function createAppApiBody(baseUrl: string, fetcher: typeof fetch = fetch) {
  const requestEffect = <A, I>(schema: Schema.Codec<A, I>, path: string, init: RequestInit = {}) =>
    Effect.gen(function* () {
      const ownerSignal = yield* Effect.abortSignal;
      const signal =
        init.signal == null ? ownerSignal : AbortSignal.any([init.signal, ownerSignal]);
      const response = yield* Effect.tryPromise({
        try: () => fetcher(`${baseUrl}${path}`, { ...init, signal }),
        catch: () => requestFailure({ status: 0, code: "unreachable", reason: "TransportFailed" }),
      });
      const parsed = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () =>
          requestFailure({
            status: response.status,
            code: "unexpected_response",
            reason: "InvalidResponse",
          }),
      }).pipe(Effect.result);
      if (!response.ok) {
        const body = Result.isSuccess(parsed) ? parsed.success : null;
        const code = Result.match(Schema.decodeUnknownResult(ErrorBody)(body), {
          onFailure: () => "request_failed",
          onSuccess: (body) => body.error,
        });
        return yield* requestFailure({ status: response.status, code, reason: "RequestRejected" });
      }
      const json: unknown = yield* Result.match(parsed, {
        onFailure: Effect.fail,
        onSuccess: Effect.succeed,
      });
      return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError(() =>
          requestFailure({
            status: response.status,
            code: "unexpected_response",
            reason: "InvalidResponse",
          }),
        ),
      );
    }).pipe(Effect.scoped);

  // The ACP SDK consumes native Promises; request composition and failures remain Effect values.
  const call = <A, I>(
    schema: Schema.Codec<A, I>,
    path: string,
    init: RequestInit = {},
  ): Promise<A> => Effect.runPromise(requestEffect(schema, path, init));

  const post = (body: JsonBody, holder?: string): RequestInit => {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (isTruthy(holder)) headers.set(sessionHolderHeader, holder);
    return { method: "POST", headers, body: JSON.stringify(body) };
  };

  return {
    baseUrl,
    fetcher,
    requestEffect,

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

    /** Calls of subagents and external agents waiting for the user. */
    approvals: (sessionId: string) =>
      call(
        Schema.Array(
          Schema.Struct({
            id: Schema.String,
            requester: ApprovalRequester,
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
  };
}

export type AppApi = ReturnType<typeof createAppApiBody>;
