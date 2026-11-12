import { HashSet, Iterable } from "effect";

/** Explicit owner execution contracts, not inferred from prefixes or tool descriptions.
 * Unknown/custom/MCP tools remain effectful. The source registration coverage test requires
 * a decision for every new built-in; changing a contract requires checking the implementation.
 */
export const builtinToolEffects = {
  find_memory: "read",
  read_evidence: "read",
  trace_evidence: "read",
  read_tool_result: "read",
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
  save_code_skill: "effectful",
  run_skill: "effectful",
  read_skill: "read",
  // A program may call any of the run's effectful tools.
  run_code: "effectful",
  // Remote calls can incur charges even when the response fails.
  kagi_search: "effectful",
  kagi_extract: "effectful",
  delegate_to_agent: "effectful",
  get_background_result: "read",
  cancel_background_task: "effectful",
  run_subagent: "effectful",
  resume_subagent: "effectful",
  get_subagent_reports: "read",
  // Report-session evidence tools only perform scoped SELECTs and redaction.
  list_report_evidence: "read",
  read_report_item: "read",
  start_new_goal: "effectful",
  update_goal: "effectful",
  update_plan: "effectful",
  edit_plan: "effectful",
  close_plan: "effectful",
  // Kanban board reads only SELECT; every board edit saves a change with the run as its author.
  read_kanban_board: "read",
  edit_kanban_board: "effectful",
  // A card verifier's verdict decides whether the card is integrated.
  record_card_verdict: "effectful",
  // Content-only handover, but the dispatch row it inserts is durable, so the response settles
  // before it runs; its refusals write nothing and are recorded through `refused`.
  notify_session: "effectful",
} as const satisfies Record<string, "read" | "effectful">;

/** Built-ins since replaced, whose calls are still in recorded runs and history. */
const retiredToolEffects = {
  // Replaced by get_subagent_reports with one attempt.
  get_subagent_report: "read",
  // Replaced by read_tool_result: a subagent's session is recorded in memory like any other.
  read_subagent_tool_result: "read",
  // Replaced by save_code_skill, which also saves ts skills.
  save_shell_skill: "effectful",
  // Replaced by completion notifications and their follow-up; it only read status.
  wait_subagents: "read",
  // Removed with report adoption and memory promotion; they saved claims and promotions.
  adopt_subagent_reports: "effectful",
  promote_memory_candidate: "effectful",
  use_promoted_memory: "effectful",
} as const satisfies Record<string, "read" | "effectful">;

export const readOnlyToolNames = HashSet.fromIterable(
  Iterable.map(
    Iterable.filter(
      Object.entries({ ...builtinToolEffects, ...retiredToolEffects }),
      ([, effect]) => effect === "read",
    ),
    ([name]) => name,
  ),
);
