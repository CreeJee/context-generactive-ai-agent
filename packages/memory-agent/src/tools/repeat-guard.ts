import type { ChatMiddleware } from "@tanstack/ai";
import {
  Effect,
  HashMap,
  HashSet,
  Match,
  MutableRef,
  Option,
  Predicate,
  Ref,
  Schema,
} from "effect";
import { JsonValue } from "../json.ts";
import { RunFailed, type RunHook } from "../loop/run.ts";
import { type CallAnswer, CallOutcome } from "../loop/scheduler.ts";
import { ToolFailed, type ToolFailureResult, toolResultKey } from "./failure.ts";

/** Tools that wait on work in progress: the same answer again is what waiting looks like. */
const waitingToolNames = HashSet.fromIterable(["get_background_result"]);

/** How many times in a row one call may return the same result before it is refused. */
const sameResultLimit = 3;

/**
 * What our tools fill afresh on every call, so two calls that found the same thing still differ:
 * a listing's paging snapshot and a command's run time.
 */
const decodeFresh = Schema.decodeUnknownOption(
  Schema.StructWithRest(
    Schema.Struct({
      snapshot: Schema.optionalKey(Schema.String),
      durationMs: Schema.optionalKey(Schema.Finite),
    }),
    [Schema.Record(Schema.String, JsonValue)],
  ),
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

const refusal = (toolName: string): ToolFailureResult =>
  ToolFailed.make({
    code: "repeated_tool_call",
    tag: "RepeatedToolCall",
    detail: `${toolName} returned the same result ${sameResultLimit} times in a row for these arguments, so it was not run again. Use that result, change the arguments, or answer. Another refused repeat stops this run.`,
  })[toolResultKey];

/** One call, the outcome it returned, and how many times in a row it did. */
interface Streak {
  readonly call: string;
  readonly outcome: string;
  readonly count: number;
}

/** What the guard knows of its run. */
interface Guard {
  /** Each call let through, by tool call id, until its result arrives. */
  readonly pending: HashMap.HashMap<string, string>;
  readonly streak: Option.Option<Streak>;
  readonly refused: boolean;
  /** The tool of a repeat refused a second time, which stops the run. */
  readonly stoppedAt: Option.Option<string>;
}

const unguarded: Guard = {
  pending: HashMap.empty(),
  streak: Option.none(),
  refused: false,
  stoppedAt: Option.none(),
};

/** The guard's refusal of a call whose arguments are `args` as JSON, or none to let it through. */
const beforeCall = (
  guard: Guard,
  id: string,
  name: string,
  args: string,
): readonly [Option.Option<ToolFailureResult>, Guard] => {
  const call = `${name}\n${args}`;
  return HashSet.has(waitingToolNames, name)
    ? [Option.none(), { ...guard, streak: Option.none() }]
    : Option.exists(
          guard.streak,
          (streak) => streak.call === call && streak.count >= sameResultLimit,
        )
      ? [
          Option.some(refusal(name)),
          {
            ...guard,
            refused: true,
            stoppedAt: guard.refused ? Option.some(name) : guard.stoppedAt,
          },
        ]
      : [Option.none(), { ...guard, pending: HashMap.set(guard.pending, id, call) }];
};

/** The guard after a call it let through returned `outcome`. */
const afterCall = (guard: Guard, id: string, outcome: string): Guard =>
  Option.match(HashMap.get(guard.pending, id), {
    onNone: () => guard,
    onSome: (call) => ({
      ...guard,
      pending: HashMap.remove(guard.pending, id),
      streak: Option.some({
        call,
        outcome,
        count: Option.match(
          Option.filter(
            guard.streak,
            (streak) => streak.call === call && streak.outcome === outcome,
          ),
          { onNone: () => 1, onSome: (streak) => streak.count + 1 },
        ),
      }),
    }),
  });

/** A result with what our tools fill afresh left out. */
const sameness = (result: JsonValue) =>
  JSON.stringify(
    Option.match(decodeFresh(result), {
      onNone: () => result,
      onSome: (fresh) => ({ ...fresh, snapshot: null, durationMs: null }),
    }),
  );

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(JsonValue));

/**
 * Stops a model that repeats itself. A call that returned the same result three times in a row is
 * refused once with a note saying so; a second refusal in the same run ends the run with
 * {@link RepeatedToolCall} before the next model call. A waiting tool never counts, and any other
 * call in between starts the count again. One guard serves one run.
 */
export const repeatGuard = (): ChatMiddleware => {
  const guard = MutableRef.make(unguarded);
  return {
    name: "memory-agent/repeat-guard",
    onBeforeToolCall(_ctx, hook) {
      const [refused, next] = beforeCall(
        MutableRef.get(guard),
        hook.toolCallId,
        hook.toolName,
        JSON.stringify(hook.args),
      );
      MutableRef.set(guard, next);
      return Option.match(refused, {
        onNone: () => undefined,
        onSome: (result) => ({ type: "skip" as const, result }),
      });
    },
    onAfterToolCall(_ctx, info) {
      MutableRef.update(guard, (current) =>
        afterCall(
          current,
          info.toolCallId,
          info.ok
            ? // The result as its tool message keeps it, which leaves out undefined fields.
              `ok\n${Option.match(decodeJsonText(JSON.stringify(info.result)), { onNone: () => "", onSome: sameness })}`
            : `error\n${Predicate.isError(info.error) ? info.error.message : JSON.stringify(info.error)}`,
        ),
      );
    },
    // After the tool phase, so every call of the last step has its result in the transcript.
    onShouldContinue(ctx) {
      return Option.match(MutableRef.get(guard).stoppedAt, {
        onNone: () => undefined,
        onSome: (toolName) => {
          throw RepeatedToolCall.make({ toolName, runId: ctx.runId, threadId: ctx.threadId });
        },
      });
    },
  };
};

const outcomeOf = (answer: CallAnswer) =>
  Match.valueTags(answer, {
    Returned: ({ result }) => `ok\n${sameness(result)}`,
    Failed: ({ message }) => `error\n${message}`,
    Refused: ({ message }) => `error\n${message}`,
  });

/** The same guard for the Effect AI loop; one hook serves one run. */
export const repeatGuardHook = Effect.map(Ref.make(unguarded), (guard): RunHook => ({
  admit: (_scope, call) =>
    Ref.modify(guard, (current) => {
      const [refused, next] = beforeCall(current, call.id, call.name, JSON.stringify(call.params));
      return [Option.map(refused, (result) => CallOutcome.Returned({ result })), next] as const;
    }),
  answered: (_scope, call, answer) =>
    Ref.update(guard, (current) => afterCall(current, call.id, outcomeOf(answer))),
  continues: ({ runId, threadId }) =>
    Effect.flatMap(Ref.get(guard), ({ stoppedAt }) =>
      Option.match(stoppedAt, {
        onNone: () => Effect.void,
        onSome: (toolName) => {
          const { message, code } = RepeatedToolCall.make({ toolName, runId, threadId });
          return Effect.fail(RunFailed.make({ message, code }));
        },
      }),
    ),
}));
