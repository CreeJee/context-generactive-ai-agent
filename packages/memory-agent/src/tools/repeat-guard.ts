import type { ChatMiddleware } from "@tanstack/ai";
import { HashSet, MutableHashMap, Option, Predicate, Schema } from "effect";
import { ToolFailed, toolResultKey } from "./failure.ts";

/** Tools that wait on work in progress: the same answer again is what waiting looks like. */
const waitingToolNames = HashSet.fromIterable(["get_background_result", "wait_subagents"]);

/** How many times in a row one call may return the same result before it is refused. */
const sameResultLimit = 3;

/**
 * What our tools fill afresh on every call, so two calls that found the same thing still differ:
 * a listing's paging snapshot and a command's run time.
 */
const isFresh = Schema.is(
  Schema.Struct({
    snapshot: Schema.optionalKey(Schema.String),
    durationMs: Schema.optionalKey(Schema.Finite),
  }),
);

/**
 * The run stopped because its model kept repeating tool calls whose result could not change.
 * Persistence and the page read `code`; the message is the run's detail.
 */
export class RepeatedToolCall extends Schema.TaggedError<RepeatedToolCall>()("RepeatedToolCall", {
  toolName: Schema.String,
  runId: Schema.String,
  threadId: Schema.String,
}) {
  get code() {
    return "repeated_tool_call" as const;
  }

  override get message() {
    return `The model repeated a ${this.toolName} call after it was told the result would not change, so the run was stopped.`;
  }
}

const refusal = (toolName: string) =>
  ToolFailed.make({
    code: "repeated_tool_call",
    tag: "RepeatedToolCall",
    detail: `${toolName} returned the same result ${sameResultLimit} times in a row for these arguments, so it was not run again. Use that result, change the arguments, or answer. Another refused repeat stops this run.`,
  })[toolResultKey];

/**
 * Stops a model that repeats itself. A call that returned the same result three times in a row is
 * refused once with a note saying so; a second refusal in the same run ends the run with
 * {@link RepeatedToolCall} before the next model call. A waiting tool never counts, and any other
 * call in between starts the count again. One guard serves one run.
 */
export const repeatGuard = (): ChatMiddleware => {
  /** Each call let through, by tool call id, until its result arrives. */
  const pending = MutableHashMap.empty<string, string>();
  let streak: { readonly call: string; readonly outcome: string; readonly count: number } | null =
    null;
  let refused = false;
  let stoppedAt: string | null = null;
  return {
    name: "memory-agent/repeat-guard",
    onBeforeToolCall(_ctx, hook) {
      if (HashSet.has(waitingToolNames, hook.toolName)) {
        streak = null;
        return undefined;
      }
      const call = `${hook.toolName}\n${JSON.stringify(hook.args)}`;
      if (streak?.call !== call || streak.count < sameResultLimit) {
        MutableHashMap.set(pending, hook.toolCallId, call);
        return undefined;
      }
      if (refused) stoppedAt = hook.toolName;
      refused = true;
      return { type: "skip", result: refusal(hook.toolName) };
    },
    onAfterToolCall(_ctx, info) {
      const call = Option.getOrUndefined(MutableHashMap.get(pending, info.toolCallId));
      if (call === undefined) return;
      MutableHashMap.remove(pending, info.toolCallId);
      const result = isFresh(info.result)
        ? { ...info.result, snapshot: null, durationMs: null }
        : info.result;
      const outcome = info.ok
        ? `ok\n${JSON.stringify(result)}`
        : `error\n${Predicate.isError(info.error) ? info.error.message : JSON.stringify(info.error)}`;
      streak =
        streak?.call === call && streak.outcome === outcome
          ? { call, outcome, count: streak.count + 1 }
          : { call, outcome, count: 1 };
    },
    // After the tool phase, so every call of the last step has its result in the transcript.
    onShouldContinue(ctx) {
      if (stoppedAt !== null)
        throw RepeatedToolCall.make({
          toolName: stoppedAt,
          runId: ctx.runId,
          threadId: ctx.threadId,
        });
      return undefined;
    },
  };
};
