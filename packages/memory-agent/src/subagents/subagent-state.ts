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
