import type { useChat } from "@tanstack/ai-react";
import { Option, Schema } from "effect";
import {
  PermissionReviewPayload,
  permissionReviewInterrupt,
  type approvalToolDefinitions,
} from "memory-agent/definitions";

export type ApprovalTools = typeof approvalToolDefinitions;
export type ApprovalInterrupts = readonly [typeof permissionReviewInterrupt];
type ChatInterrupt = ReturnType<
  typeof useChat<ApprovalTools, undefined, unknown, ApprovalInterrupts>
>["interrupts"][number];

/** A call waiting for the user, whichever permission mode asked. */
export type PendingApproval =
  | {
      /** `ask` mode: TanStack paused before a needsApproval tool. */
      readonly kind: "tool-approval";
      readonly id: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly argumentsJson: string;
      readonly answer: (approved: boolean) => void;
    }
  | {
      /** `auto` mode: the review could not allow the call alone. */
      readonly kind: "permission-review";
      readonly id: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly argumentsJson: string;
      readonly reviewReason: string;
      /** Whether a review was unsure, or the tool asks on every call. */
      readonly askedBy: "review" | "every_call";
      readonly answer: (approved: boolean) => void;
    };

const decodeReview = Schema.decodeUnknownOption(
  Schema.Struct({ payload: PermissionReviewPayload }),
);

/** Converts a TanStack interrupt to the approval shape rendered by the app. */
export function toPendingApproval(interrupt: ChatInterrupt): PendingApproval | null {
  switch (interrupt.kind) {
    case "tool-approval":
      return {
        kind: "tool-approval",
        id: interrupt.id,
        toolCallId: interrupt.toolCallId,
        toolName: interrupt.toolName,
        argumentsJson: JSON.stringify(interrupt.originalArgs),
        answer: (approved) => interrupt.resolveInterrupt(approved),
      };
    case "generic": {
      if (interrupt.binding.definitionId !== permissionReviewInterrupt.id) return null;
      const review = Option.getOrUndefined(decodeReview(interrupt));
      if (!review) return null;
      return {
        kind: "permission-review",
        id: interrupt.id,
        toolCallId: review.payload.toolCallId,
        toolName: review.payload.toolName,
        argumentsJson: review.payload.arguments,
        reviewReason: review.payload.reason,
        askedBy: review.payload.askedBy ?? "review",
        answer: (approved) => interrupt.resolveInterrupt({ approved }),
      };
    }
    case "unbound":
      return null;
  }
}
