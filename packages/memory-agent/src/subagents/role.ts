import { HashSet } from "effect";
import type { RunTool } from "../tools/run-tool.ts";

const parentToolNames = HashSet.fromIterable([
  "start_new_goal",
  "update_goal",
  "edit_goal",
  "update_plan",
  "edit_plan",
  "close_plan",
  "delegate_to_agent",
  "cancel_background_task",
  "get_background_result",
  // A child keeps a memo of its own session instead.
  "update_memo",
]);

/** Children report local progress; the parent owns session planning and final adoption. */
export const childRunTools = (tools: ReadonlyArray<RunTool>) =>
  tools.filter(({ tool }) => !HashSet.has(parentToolNames, tool.name));
