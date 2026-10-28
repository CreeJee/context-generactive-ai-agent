import { Effect, Option, Schema } from "effect";
import type { RunHook } from "../loop/run.ts";
import { CallOutcome } from "../loop/scheduler.ts";
import { memoryReadRunTools, type MemoryToolEnvironment } from "../tools/memory.ts";
import { BtwToolName } from "./contracts.ts";

const allowed = Schema.is(BtwToolName);

/**
 * Search, read and trace over the same project's memory, with no run binding: nothing records a
 * retrieval, a use or a promotion.
 */
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
