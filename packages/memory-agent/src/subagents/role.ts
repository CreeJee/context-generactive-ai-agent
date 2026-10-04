import type { AnyServerTool } from "@tanstack/ai";

const parentToolNames = new Set([
  "start_new_goal",
  "update_goal",
  "update_plan",
  "update_workflow_progress",
  "record_workflow_blocker",
  "promote_memory_candidate",
  "use_promoted_memory",
  "delegate_to_agent",
  "cancel_background_task",
  "get_background_result",
]);

/** Children report local progress; the parent owns session planning and final adoption. */
export function childTools(tools: readonly AnyServerTool[]) {
  return tools.filter((tool) => !parentToolNames.has(tool.name));
}
