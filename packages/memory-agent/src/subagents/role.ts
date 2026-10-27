import { HashSet } from "effect";
import type { RunTool } from "../tools/run-tool.ts";

const parentToolNames = HashSet.fromIterable([
  "start_new_goal",
  "update_goal",
  "update_plan",
  "close_plan",
  "update_workflow_progress",
  "record_workflow_blocker",
  "promote_memory_candidate",
  "use_promoted_memory",
  "delegate_to_agent",
  "cancel_background_task",
  "get_background_result",
]);

/** Children report local progress; the parent owns session planning and final adoption. */
export const childRunTools = (tools: ReadonlyArray<RunTool>) =>
  tools.filter(({ tool }) => !HashSet.has(parentToolNames, tool.name));
