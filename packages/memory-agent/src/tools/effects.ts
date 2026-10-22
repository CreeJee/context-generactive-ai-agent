import { HashSet } from "effect";

/** Explicit owner execution contracts, not inferred from prefixes or tool descriptions.
 * Unknown/custom/MCP tools remain effectful. The source registration coverage test requires
 * a decision for every new built-in; changing a contract requires checking the implementation.
 */
export const builtinToolEffects = {
  // Search records durable memory_usage_events when promoted matches are retrieved.
  find_memory: "effectful",
  read_evidence: "read",
  trace_evidence: "read",
  read_tool_result: "read",
  promote_memory_candidate: "effectful",
  use_promoted_memory: "effectful",
  // Filesystem paging/snapshot caches do not acknowledge or change domain state.
  list_files: "read",
  search_files: "read",
  read_file: "read",
  write_file: "effectful",
  edit_file: "effectful",
  delete_file: "effectful",
  list_outside_files: "read",
  read_outside_file: "read",
  search_outside_file: "read",
  write_outside_file: "effectful",
  delete_outside_file: "effectful",
  save_shell_skill: "effectful",
  run_skill: "effectful",
  read_skill: "read",
  // Remote calls can incur charges even when the response fails.
  kagi_search: "effectful",
  kagi_extract: "effectful",
  delegate_to_agent: "effectful",
  get_background_result: "read",
  cancel_background_task: "effectful",
  run_subagent: "effectful",
  message_subagent: "effectful",
  resume_subagent: "effectful",
  read_subagent_tool_result: "read",
  // Report caches are run-local; durable review/adoption is a separate middleware RPC.
  get_subagent_report: "read",
  get_subagent_reports: "read",
  // Reads status/cursor and registers a cancellable waiter; never consumes notifications.
  wait_subagents: "read",
  adopt_subagent_reports: "effectful",
  // Report-session evidence tools only perform scoped SELECTs and redaction.
  list_report_evidence: "read",
  read_report_item: "read",
  record_workflow_blocker: "effectful",
  start_new_goal: "effectful",
  update_goal: "effectful",
  update_plan: "effectful",
  close_plan: "effectful",
  update_workflow_progress: "effectful",
  // Kanban board reads only SELECT; every board tool saves a change with the run as its author.
  read_kanban_board: "read",
  split_card: "effectful",
  merge_cards: "effectful",
  cancel_card: "effectful",
  move_card: "effectful",
  settle_change_request: "effectful",
  apply_goal_change: "effectful",
  requeue_card: "effectful",
  // A card verifier's verdict decides whether the card is integrated.
  record_card_verdict: "effectful",
} as const satisfies Record<string, "read" | "effectful">;

export const readOnlyToolNames = HashSet.fromIterable(
  Object.entries(builtinToolEffects).flatMap(([name, effect]) => {
    switch (effect) {
      case "read":
        return [name];
      case "effectful":
        return [];
    }
  }),
);
