import { Context, Crypto, Effect, HashSet, Layer, Match, Option } from "effect";
import type { StoredInterruptPayload } from "../chat-store/schema.ts";
import type { JsonValue } from "../json.ts";
import { asRunFailed, type RunHook } from "../loop/run.ts";
import { type Admission, CallOutcome } from "../loop/scheduler.ts";
import { InterruptAnswer } from "../loop/store.ts";
import type { ModelSelection } from "../providers/contracts.ts";
import type { Project } from "../projects/projects.ts";
import { PermissionClassifier } from "./classifier.ts";
import { PermissionReviews, type PermissionReview } from "./reviews.ts";

export interface GateBinding {
  readonly project: Project;
  readonly sessionId: string;
  readonly selection: ModelSelection;
  /** Tools whose every call this gate decides. */
  readonly gated: HashSet.HashSet<string>;
  /**
   * `classifier`: the permission review decides first and asks the user only when unsure (`auto`
   * mode). `user`: every call asks the user (tools without a static approval in `ask` mode, such
   * as MCP tools).
   */
  readonly decider: "classifier" | "user";
}

/** Asked of the user when no review ran: the tool needs a decision on every call. */
const askEveryCallReason = "호출할 때마다 확인하는 도구예요.";

/** A gated call, with its arguments as the model wrote them, which its review keeps. */
interface GatedCall {
  readonly id: string;
  readonly name: string;
  readonly written: string;
}

/** What the model receives instead of a result when a call does not run. */
const refusal = (review: Option.Option<PermissionReview>): JsonValue =>
  Match.value(Option.getOrNull(review)).pipe(
    Match.when({ decision: "block" }, ({ reason }) => ({
      error: `blocked_by_permission_review: ${reason}`,
    })),
    Match.when({ decision: "denied" }, () => ({
      approved: false,
      message: "User denied this action",
    })),
    Match.orElse(() => ({
      error: "permission_review_missing: the call was not reviewed, so it did not run.",
    })),
  );

/** Why the user is asked: the review was unsure, or the tool asks on every call. */
interface Asking {
  readonly reason: string;
  readonly askedBy: "review" | "every_call";
}

/** The schema of the user's answer, as the stored interrupt carries it. */
const reviewResponseSchema = {
  type: "object",
  properties: { approved: { type: "boolean" } },
  required: ["approved"],
  additionalProperties: false,
};

/** The decision in force lets the call run. */
const isAllowed = (review: Option.Option<PermissionReview>) =>
  Option.exists(review, ({ decision }) => decision === "allow" || decision === "approved");

/**
 * One run's gate: the review in force for a call, and the review a call gets when it has none.
 * Everything a gate decides is appended to the review log, which a resumed run reads.
 */
const gateFor = Effect.fnUntraced(function* (binding: GateBinding) {
  const classifier = yield* PermissionClassifier;
  const reviews = yield* PermissionReviews;
  const { sessionId } = binding;

  const record = (
    call: GatedCall,
    review: Pick<PermissionReview, "decision" | "decidedBy" | "reason">,
  ) =>
    reviews.record({
      sessionId,
      toolCallId: call.id,
      toolName: call.name,
      input: call.written,
      ...review,
    });

  /** The review in force for the call; one for other arguments or another tool does not count. */
  const reviewOf = (call: GatedCall) =>
    Effect.map(reviews.latest(sessionId, call.id), (latest) =>
      Option.filter(
        Option.fromNullishOr(latest),
        (review) => review.toolName === call.name && review.input === call.written,
      ),
    );

  /**
   * The review the call is decided by, the classifier's when it had none; none when the user
   * decides every call of its tool.
   */
  const decisionOf = (call: GatedCall) =>
    Effect.flatMap(
      reviewOf(call),
      Option.match({
        onSome: Effect.succeedSome,
        onNone: () =>
          binding.decider === "user"
            ? Effect.succeedNone
            : classifier
                .classify({
                  project: binding.project,
                  sessionId,
                  selection: binding.selection,
                  toolName: call.name,
                  argumentsJson: call.written,
                })
                .pipe(
                  Effect.flatMap(({ decision, decidedBy, reason }) =>
                    record(call, { decision, decidedBy, reason }),
                  ),
                  Effect.asSome,
                ),
      }),
    );

  /** Why the user is asked about the call, or none when the decision needs no one. */
  const askingOf = (decision: Option.Option<PermissionReview>) =>
    Option.match(decision, {
      onNone: () => Option.some<Asking>({ reason: askEveryCallReason, askedBy: "every_call" }),
      onSome: ({ decision, reason }) =>
        decision === "ask" ? Option.some<Asking>({ reason, askedBy: "review" }) : Option.none(),
    });

  /** The user's answers to the reviews a resumed run brings, each its own append. */
  const answered = (
    answers: ReadonlyArray<{ readonly call: GatedCall; readonly approved: boolean }>,
  ) =>
    Effect.forEach(
      answers,
      ({ call, approved }) =>
        record(call, {
          decision: approved ? "approved" : "denied",
          decidedBy: "user",
          reason: approved ? "사용자가 승인했어요." : "사용자가 거부했어요.",
        }),
      { discard: true },
    );

  return { reviewOf, decisionOf, askingOf, answered };
});

/** The interrupt that asks the user about a gated call. */
const askUser = (call: GatedCall, { reason, askedBy }: Asking) =>
  Effect.map(
    Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomUUIDv7()),
    (id): Admission<StoredInterruptPayload> =>
      CallOutcome.Waiting({
        request: {
          id: `interrupt-${id}`,
          reason: "permission_review",
          message: reason,
          responseSchema: reviewResponseSchema,
          metadata: {
            payload: {
              toolCallId: call.id,
              toolName: call.name,
              arguments: call.written,
              reason,
              askedBy,
            },
          },
        },
      }),
  );

/**
 * The gate of an Effect AI run. A call waiting on the user does not hold the others back: each
 * gated call is decided on its own, and the user is asked about those the review cannot decide.
 */
export const makePermissionGateHook = Effect.fnUntraced(function* (
  binding: GateBinding,
): Effect.fn.Return<RunHook<Crypto.Crypto>, never, PermissionClassifier | PermissionReviews> {
  const gate = yield* gateFor(binding);
  return {
    // A cancelled question counts as the user's refusal.
    started: (_scope, resumed) =>
      gate
        .answered(
          resumed.flatMap(({ interrupt: { payload }, answer }) =>
            payload.reason === "permission_review"
              ? [
                  {
                    call: {
                      id: payload.metadata.payload.toolCallId,
                      name: payload.metadata.payload.toolName,
                      written: payload.metadata.payload.arguments,
                    },
                    approved: InterruptAnswer.$match(answer, {
                      Resolved: ({ response }) => response.approved,
                      Cancelled: () => false,
                    }),
                  },
                ]
              : [],
          ),
        )
        .pipe(Effect.mapError(asRunFailed)),

    admit: (_scope, { id, name }, written) => {
      const call: GatedCall = { id, name, written };
      return HashSet.has(binding.gated, name)
        ? Effect.flatMap(gate.decisionOf(call), (decision) =>
            Option.match(gate.askingOf(decision), {
              onSome: (asking) => Effect.asSome(askUser(call, asking)),
              onNone: () =>
                Effect.succeed(
                  isAllowed(decision)
                    ? Option.none()
                    : Option.some(CallOutcome.Returned({ result: refusal(decision) })),
                ),
            }),
          ).pipe(Effect.mapError(asRunFailed))
        : Effect.succeedNone;
    },
  };
});

const make = Effect.gen(function* () {
  const context = yield* Effect.context<PermissionClassifier | PermissionReviews>();
  return {
    /** The gate of one Effect AI run. */
    hookFor: (binding: GateBinding) =>
      Effect.provideContext(makePermissionGateHook(binding), context),
  };
});

/** `auto` permission mode: classify each gated call, ask only when the verdict says so. */
export class PermissionGate extends Context.Service<PermissionGate, Effect.Success<typeof make>>()(
  "memory-agent/permissions/gate/PermissionGate",
) {
  static readonly layer = Layer.effect(PermissionGate, make);
}
