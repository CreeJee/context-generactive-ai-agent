/** Subagent state as the chat page sees it. Safe to import in the browser. */

export type SubagentStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface SubagentView {
  readonly id: string;
  /** null for a one-off run. */
  readonly name: string | null;
  readonly status: SubagentStatus;
  readonly lastTask: string;
  readonly lastAnswer: string | null;
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A child's tool call waiting for the user. */
export interface SubagentApprovalView {
  readonly id: string;
  readonly subagentId: string;
  readonly agent: string | null;
  readonly toolName: string;
  readonly argumentsJson: string;
  readonly reason: string;
  /** `review`: the permission review was unsure. `every_call`: the tool asks on every call. */
  readonly askedBy: "review" | "every_call";
  readonly createdAt: number;
}

export interface SubagentsState {
  readonly subagents: readonly SubagentView[];
  readonly approvals: readonly SubagentApprovalView[];
}
