import type { AnyServerTool, ChatMiddleware } from "@tanstack/ai";
import { Schema } from "effect";
import { createMemoryTools, type MemoryToolEnvironment } from "../tools/memory.ts";
import { BtwToolName } from "./contracts.ts";

const allowed = Schema.is(BtwToolName);

/**
 * Search, read and trace over the same project's memory, with no run binding: nothing records a
 * retrieval, a use or a promotion.
 */
export const btwEvidenceTools = (
  env: MemoryToolEnvironment,
  projectId: string,
): AnyServerTool[] => [...createMemoryTools(env, projectId, undefined, "project").tools];

/**
 * Server-side allowlist. Drops any other tool from every model request and refuses a call to one
 * without running it, so neither a changed request nor a model naming another tool can write.
 */
export const btwToolGuard: ChatMiddleware = {
  name: "memory-agent/btw-tool-guard",
  onConfig(_ctx, config) {
    const tools = config.tools.filter((tool) => allowed(tool.name));
    return tools.length === config.tools.length ? undefined : { tools };
  },
  onBeforeToolCall(_ctx, call) {
    if (allowed(call.toolName)) return undefined;
    return { type: "skip", result: { error: "btw_tool_not_allowed", tool: call.toolName } };
  },
};
