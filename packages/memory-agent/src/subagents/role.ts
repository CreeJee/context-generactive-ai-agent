import { HashSet } from "effect";
import type { AnyServerTool } from "@tanstack/ai";
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
export function childTools(tools: readonly AnyServerTool[]) {
  return tools.filter((tool) => !HashSet.has(parentToolNames, tool.name));
}

/** {@link childTools} for the Effect AI loop's tools. */
export const childRunTools = (tools: ReadonlyArray<RunTool>) =>
  tools.filter(({ tool }) => !HashSet.has(parentToolNames, tool.name));
