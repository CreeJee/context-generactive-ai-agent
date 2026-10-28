import { Data, Match } from "effect";
import type { PendingInterrupts, ResumeEntry } from "memory-agent/chat-api";

/** A call waiting for the user, whichever permission mode asked. */
export type PendingApproval = Data.TaggedEnum<{
  /** `ask` mode: the run paused before a tool that needs approval. */
  "tool-approval": {
    readonly id: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly argumentsJson: string;
  };
  /** `auto` mode: the review could not allow the call alone. */
  "permission-review": {
    readonly id: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly argumentsJson: string;
    readonly reviewReason: string;
    /** Whether a review was unsure, or the tool asks on every call. */
    readonly askedBy: "review" | "every_call";
  };
}>;
export const PendingApproval = Data.taggedEnum<PendingApproval>();

/** An interrupt the run waits for, as the approval card shows it. */
export const toPendingApproval = Match.type<PendingInterrupts["pending"][number]>().pipe(
  Match.discriminatorsExhaustive("reason")({
    tool_call: (interrupt) =>
      PendingApproval["tool-approval"]({
        id: interrupt.id,
        toolCallId: interrupt.toolCallId,
        toolName: interrupt.metadata.toolName,
        argumentsJson: JSON.stringify(interrupt.metadata.input),
      }),
    permission_review: ({ id, metadata: { payload } }) =>
      PendingApproval["permission-review"]({
        id,
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        argumentsJson: payload.arguments,
        reviewReason: payload.reason,
        askedBy: payload.askedBy ?? "review",
      }),
  }),
);

/** The page's decision on one approval, as the run that resumes reads it. */
export const approvalAnswer = ({
  id,
  approved,
}: {
  readonly id: string;
  readonly approved: boolean;
}): ResumeEntry => ({ interruptId: id, status: "resolved", payload: { approved } });
