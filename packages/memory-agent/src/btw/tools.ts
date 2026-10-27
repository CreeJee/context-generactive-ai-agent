import type { AnyServerTool } from "@tanstack/ai";
import { Effect, Function as EffectFunction, Option, Schema } from "effect";
import type { RunHook } from "../loop/run.ts";
import { CallOutcome } from "../loop/scheduler.ts";
import {
  createMemoryTools,
  memoryReadRunTools,
  type MemoryToolEnvironment,
} from "../tools/memory.ts";
import { BtwToolName } from "./contracts.ts";

const allowed = Schema.is(BtwToolName);

/**
 * Search, read and trace over the same project's memory, with no run binding: nothing records a
 * retrieval, a use or a promotion.
 */
export const btwEvidenceTools: {
  (projectId: string): (env: MemoryToolEnvironment) => AnyServerTool[];
} & typeof btwEvidenceToolsBody = EffectFunction.dual(2, btwEvidenceToolsBody);
function btwEvidenceToolsBody(env: MemoryToolEnvironment, projectId: string): AnyServerTool[] {
  return [...createMemoryTools(env, projectId, undefined, "project").tools];
}

/** {@link btwEvidenceTools} for the Effect AI loop (docs/effect-ai-migration.md step 3). */
export const btwEvidenceRunTools = ({
  env,
  projectId,
}: {
  readonly env: MemoryToolEnvironment;
  readonly projectId: string;
}) => memoryReadRunTools({ env, projectId, scope: "project" });

/**
 * Server-side allowlist. A BTW run lists only {@link btwEvidenceRunTools}, and a call to any other
 * tool is refused without running it, so a model naming another tool cannot write.
 */
export const btwToolGuardHook: RunHook = {
  admit: (_scope, call) =>
    Effect.succeed(
      allowed(call.name)
        ? Option.none()
        : Option.some(
            CallOutcome.Returned({ result: { error: "btw_tool_not_allowed", tool: call.name } }),
          ),
    ),
};
