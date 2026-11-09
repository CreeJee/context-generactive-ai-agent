import { Context, Effect, Layer, Option, Schema } from "effect";
import { PermissionClassifier } from "../permissions/classifier.ts";
import type { Project } from "../projects/projects.ts";
import { ActiveProvider } from "../providers/active-provider.ts";
import type { CardApprovalReview } from "../workflow/card.ts";
import type { GoalArtifact, PlanStep } from "../workflow/workflow.ts";

/** Cards the planner added to a board whose project runs in the auto permission mode. */
export interface CardApprovalRequest {
  readonly project: Project;
  readonly sessionId: string;
  readonly goal: GoalArtifact;
  readonly cards: readonly PlanStep[];
}

/** What the reviewer reads: the Goal's bounds and the work each card would do. */
const ReviewedCards = Schema.Struct({
  goal: Schema.Struct({
    statement: Schema.String,
    constraints: Schema.Array(Schema.String),
    nonGoals: Schema.Array(Schema.String),
  }),
  cards: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      description: Schema.String,
      acceptanceCriteria: Schema.Array(Schema.String),
    }),
  ),
});
const encodeReviewed = Schema.encodeEffect(Schema.fromJsonString(ReviewedCards));

/** The reviewer is not asked when nothing could be read; the user decides then. */
const unreviewed: CardApprovalReview = {
  decision: "ask",
  reason: "카드를 자동으로 검토하지 못해서 직접 확인이 필요해요.",
};

/**
 * The auto permission mode's judgement on cards the planner added: none when they may run, or the
 * review that leaves them to the user.
 */
export class CardApprovalReviewer extends Context.Service<
  CardApprovalReviewer,
  {
    readonly review: (
      request: CardApprovalRequest,
    ) => Effect.Effect<Option.Option<CardApprovalReview>>;
  }
>()("memory-agent/kanban/card-approval/CardApprovalReviewer") {
  /** The permission classifier on the planner's model reviews the cards as one call. */
  static readonly layer = Layer.effect(
    CardApprovalReviewer,
    Effect.gen(function* () {
      const classifier = yield* PermissionClassifier;
      const active = yield* ActiveProvider;
      return {
        review: Effect.fn("CardApprovalReviewer.review")(
          function* (request: CardApprovalRequest) {
            const selection = yield* active.selectedFor("planner");
            if (selection === null) return Option.some(unreviewed);
            const verdict = yield* classifier.classify({
              project: request.project,
              sessionId: request.sessionId,
              selection,
              toolName: "add_kanban_cards",
              argumentsJson: yield* encodeReviewed({
                goal: request.goal,
                cards: request.cards,
              }),
            });
            return verdict.decision === "allow"
              ? Option.none()
              : Option.some<CardApprovalReview>({
                  decision: verdict.decision,
                  reason: verdict.reason,
                });
          },
          // Fails closed: anything that keeps the review from running leaves the cards to the user.
          Effect.catch(() => Effect.succeedSome(unreviewed)),
          Effect.catchDefect(() => Effect.succeedSome(unreviewed)),
        ),
      };
    }),
  );
}
