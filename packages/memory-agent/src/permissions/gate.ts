import type { ChatMiddleware, ModelMessage, ToolCall } from "@tanstack/ai";
import { Context, Effect, Layer } from "effect";
import type { ModelSelection } from "../codex/models.ts";
import type { Project } from "../projects/projects.ts";
import { permissionReviewInterrupt } from "../tools/definitions.ts";
import { PermissionClassifier } from "./classifier.ts";
import { PermissionReviews, type PermissionReview } from "./reviews.ts";

export interface GateBinding {
  readonly project: Project;
  readonly sessionId: string;
  readonly selection: ModelSelection;
  /** Tools whose every call this gate decides. */
  readonly gated: ReadonlySet<string>;
  /**
   * `classifier`: the permission review decides first and asks the user only when unsure (`auto`
   * mode). `user`: every call asks the user (tools without a static TanStack approval in `ask`
   * mode, such as MCP tools).
   */
  readonly decider: "classifier" | "user";
}

/** Asked of the user when no review ran: the tool needs a decision on every call. */
const askEveryCallReason = "호출할 때마다 확인하는 도구예요.";

/** Gated calls the model made that have no result yet: the batch about to execute. */
function pendingGatedCalls(
  messages: ReadonlyArray<ModelMessage>,
  gatedToolNames: ReadonlySet<string>,
): ToolCall[] {
  const answered = new Set(
    messages.flatMap((message) =>
      message.role === "tool" && message.toolCallId ? [message.toolCallId] : [],
    ),
  );
  return messages.flatMap((message) =>
    message.role === "assistant"
      ? (message.toolCalls ?? []).filter(
          (call) => gatedToolNames.has(call.function.name) && !answered.has(call.id),
        )
      : [],
  );
}

/** What the model receives instead of a result when a call does not run. */
function refusal(review: PermissionReview | null) {
  if (review?.decision === "block")
    return { error: `blocked_by_permission_review: ${review.reason}` };
  if (review?.decision === "denied") return { approved: false, message: "User denied this action" };
  return { error: "permission_review_missing: the call was not reviewed, so it did not run." };
}

const make = Effect.gen(function* () {
  const classifier = yield* PermissionClassifier;
  const reviews = yield* PermissionReviews;

  return {
    /**
     * Before tools run, every gated call gets a decision. With the classifier, each call gets a
     * verdict (kept in `permission_reviews`, so a resumed run does not review again) and only `ask`
     * verdicts pause the run; with the user as decider every call pauses. Pauses are
     * permission-review interrupts; the user's answer is recorded when the run resumes. Right
     * before each gated call executes, only `allow` and `approved` let it through.
     */
    forRun(binding: GateBinding): ChatMiddleware<unknown, typeof permissionReviewInterrupt> {
      const { sessionId, gated } = binding;

      return {
        name: "memory-agent/permission-gate",

        async onInterruptBoundary(ctx) {
          if (ctx.phase !== "beforeTools") return undefined;
          const asks = [];
          const ask = (call: ToolCall, reason: string, askedBy: "review" | "every_call") =>
            permissionReviewInterrupt.interrupt({
              key: call.id,
              reason: "permission_review",
              message: reason,
              payload: {
                toolCallId: call.id,
                toolName: call.function.name,
                arguments: call.function.arguments,
                reason,
                askedBy,
              },
            });
          for (const call of pendingGatedCalls(ctx.messages, gated)) {
            let review = reviews.latest(sessionId, call.id);
            if (!review && binding.decider === "user") {
              asks.push(ask(call, askEveryCallReason, "every_call"));
              continue;
            }
            if (!review) {
              const verdict = await classifier.classify({
                project: binding.project,
                sessionId,
                selection: binding.selection,
                toolName: call.function.name,
                argumentsJson: call.function.arguments,
              });
              review = reviews.record({
                sessionId,
                toolCallId: call.id,
                toolName: call.function.name,
                input: call.function.arguments,
                decision: verdict.decision,
                decidedBy: verdict.decidedBy,
                reason: verdict.reason,
              });
            }
            if (review.decision === "ask") asks.push(ask(call, review.reason, "review"));
          }
          return asks.length > 0 ? { interrupts: asks } : undefined;
        },

        onInterruptResolution(_ctx, resolutions) {
          for (const resolution of resolutions.for(permissionReviewInterrupt)) {
            const { payload } = resolution.request;
            if (!payload) continue;
            const approved = resolution.status === "resolved" && resolution.response.approved;
            reviews.record({
              sessionId,
              toolCallId: payload.toolCallId,
              toolName: payload.toolName,
              input: payload.arguments,
              decision: approved ? "approved" : "denied",
              decidedBy: "user",
              reason: approved ? "사용자가 승인했어요." : "사용자가 거부했어요.",
            });
          }
        },

        onBeforeToolCall(_ctx, hook) {
          if (!gated.has(hook.toolName)) return undefined;
          const review = reviews.latest(sessionId, hook.toolCallId);
          if (review?.decision === "allow" || review?.decision === "approved") return undefined;
          return { type: "skip", result: refusal(review) };
        },
      };
    },
  };
});

/** `auto` permission mode: classify each gated call, ask only when the verdict says so. */
export class PermissionGate extends Context.Tag("memory-agent/PermissionGate")<
  PermissionGate,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.effect(PermissionGate, make);
}
