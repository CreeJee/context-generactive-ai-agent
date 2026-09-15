/** Approval requests that cannot pause the run, as the page sees them. Safe to import in the browser. */

/** Who is asking, when it is not the conversation's own agent. */
export type ApprovalRequester =
  | { readonly kind: "subagent"; readonly subagentId: string; readonly name: string | null }
  | { readonly kind: "external_agent"; readonly agent: string };

export interface RelayedApprovalView {
  readonly id: string;
  readonly requester: ApprovalRequester;
  readonly toolName: string;
  /** What the call would do, as JSON. */
  readonly argumentsJson: string;
  readonly reason: string;
  /**
   * `review`: the permission review was unsure. `every_call`: the tool asks on every call.
   * `agent`: an external agent asked through its own permission request.
   */
  readonly askedBy: "review" | "every_call" | "agent";
  readonly createdAt: number;
}
