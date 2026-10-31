import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { DecisionAnswer, HumanDecisionRequest } from "../../kanban/contracts.ts";
import { Session } from "../../sessions/contracts.ts";
import { sessionHolderHeaders } from "../chat-api.ts";
import { appRefusalFields, refusalWith, SameSite } from "../refusal.ts";

const appRefusal = refusalWith(appRefusalFields);

/** A conversation to start in a project, with the app's model or a trusted external agent. */
export const CreateSession = Schema.Struct({
  projectId: Schema.NonEmptyString,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  /** Talk directly to this trusted external ACP agent instead of the app's model. */
  agent: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
});
export type CreateSession = typeof CreateSession.Type;

/** A person's answer to a card's decision, for the facts they saw. */
export const DecisionAnswerInput = Schema.Struct({
  goalInstanceId: Schema.String,
  cardId: Schema.String,
  /** The facts the person saw; the request's latest are answered only. */
  factsSeq: Schema.Int,
  answer: DecisionAnswer,
});
export type DecisionAnswerInput = typeof DecisionAnswerInput.Type;

/** The project the request names is not registered. */
const UnknownProject = appRefusal(404, ["project_not_found"]);

/** The session the path names does not exist. */
const UnknownSession = appRefusal(404, ["session_not_found"]);

/** Another page holds the session. */
const SessionInUse = appRefusal(423, ["session_in_use"]);

/** The external agent is not configured, trusted and running for the project. */
const AgentUnavailable = appRefusal(409, ["external_agent_unavailable"]);

/**
 * A decision answer refused with its reason: the request is unknown or another card's (404), the
 * answer does not fit the question (400), or the request, card or facts moved on (409).
 */
const DecisionRefusals = [
  appRefusal(404, ["request_missing", "request_mismatch"]),
  appRefusal(400, ["answer_invalid"]),
  appRefusal(409, [
    "card_missing",
    "goal_superseded",
    "request_closed",
    "answer_conflict",
    "facts_changed",
  ]),
] as const;

/** Reading or writing the session's decisions or board failed. */
const SessionStorageFailed = appRefusal(500, [
  "storage_failed",
  "kanban_storage_failed",
  "workflow_storage_failed",
]);

/** Every refusal of the group, for `appRefusalStatus`. */
export const sessionsRefusals = [
  UnknownProject,
  UnknownSession,
  SessionInUse,
  AgentUnavailable,
  ...DecisionRefusals,
  SessionStorageFailed,
];

const session = { session: Schema.String };

/** A project's conversations and what each one runs (`/api/sessions/*`). */
export class SessionsGroup extends HttpApiGroup.make("sessions")
  .add(
    /** The project's conversations, newest first; `archived=1` lists only the archived ones. */
    HttpApiEndpoint.get("list", "/api/sessions", {
      query: { project: Schema.NonEmptyString, archived: Schema.optional(Schema.Literal("1")) },
      success: Schema.Array(Session),
    }),
    /** Starts a conversation in a project. */
    HttpApiEndpoint.post("create", "/api/sessions", {
      payload: CreateSession,
      success: Session.pipe(HttpApiSchema.status(201)),
      error: [UnknownProject, AgentUnavailable],
    }),
    /** The board's cards waiting for a person's decision. */
    HttpApiEndpoint.get("decisions", "/api/sessions/:session/decisions", {
      params: session,
      success: Schema.Array(HumanDecisionRequest),
      error: [UnknownSession, SessionStorageFailed],
    }),
    /**
     * A person answers a card's decision, from its board or the project inbox. The same answer
     * again is accepted.
     */
    HttpApiEndpoint.post("answerDecision", "/api/sessions/:session/decisions/:decision", {
      params: { ...session, decision: Schema.String },
      headers: sessionHolderHeaders,
      payload: DecisionAnswerInput,
      success: HumanDecisionRequest,
      error: [SessionInUse, ...DecisionRefusals, SessionStorageFailed],
    }),
  )
  .middleware(SameSite) {}
