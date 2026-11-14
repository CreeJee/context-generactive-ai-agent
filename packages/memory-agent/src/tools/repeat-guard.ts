import { Effect, HashMap, HashSet, Match, Option, Ref, Schema } from "effect";
import { JsonValue } from "../json.ts";
import { RunFailed, type RunHook } from "../loop/run.ts";
import { type CallAnswer, CallResult } from "../loop/scheduler.ts";
import { failureResult, ToolFailed, type ToolFailureResult } from "./failure.ts";

/** Tools that wait on work in progress: the same answer again is what waiting looks like. */
const waitingToolNames = HashSet.fromIterable(["get_background_result"]);

/** How many times in a row one call may return the same result before it is refused. */
const sameResultLimit = 3;

/**
 * How many times in a row one tool may fail the same way, whatever its arguments, before it is
 * refused. Past runs that were working stayed at 11 or fewer; models stuck guessing arguments
 * reached hundreds.
 */
const sameFailureLimit = 20;

/** A command that did not succeed, as run_skill and the outside command tools answer it. */
const decodeUnsucceeded = Schema.decodeUnknownOption(
  Schema.Struct({
    status: Schema.Literals(["failed", "timed_out", "cancelled"]),
    exitCode: Schema.NullOr(Schema.Finite),
    stdout: Schema.String,
    stderr: Schema.String,
  }),
);

/** A result that reports an error in place of what was asked for. */
const decodeErrorResult = Schema.decodeUnknownOption(Schema.Struct({ error: Schema.String }));

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

export const repeatedToolCallCode = "repeated_tool_call";

/**
 * The run stopped because its model kept repeating tool calls whose result could not change.
 * Persistence and the page read `code`; the message is the run's detail.
 */
export class RepeatedToolCall extends Schema.TaggedError<
  RepeatedToolCall,
  { readonly brand: unique symbol }
>()("RepeatedToolCall", {
  toolName: Schema.String,
  runId: Schema.String,
  threadId: Schema.String,
}) {
  get code() {
    return repeatedToolCallCode;
  }

  override get message() {
    return `The model repeated a ${this.toolName} call after it was refused for repeating itself, so the run was stopped.`;
  }
}

const refusal = (detail: string): ToolFailureResult =>
  failureResult(ToolFailed.make({ code: repeatedToolCallCode, tag: "RepeatedToolCall", detail }));

const sameResultRefusal = (toolName: string) =>
  refusal(
    `${toolName} returned the same result ${sameResultLimit} times in a row for these arguments, so it was not run again. Use that result, change the arguments, or answer. Another refused repeat stops this run.`,
  );

const sameFailureRefusal = (toolName: string) =>
  refusal(
    `${toolName} failed the same way ${sameFailureLimit} times in a row, with whatever arguments it was given, so it was not run again. Fix what the error names, use another tool, or answer. Another refused call stops this run.`,
  );

/** One call, the outcome it returned, and how many times in a row it did. */
interface Streak {
  readonly call: string;
  readonly outcome: string;
  readonly count: number;
}

/** One tool, the failure it answered, and how many of its calls in a row did. */
interface FailureStreak {
  readonly name: string;
  readonly failure: string;
  readonly count: number;
}

/** A call let through: its tool, and the tool with its arguments. */
interface Pending {
  readonly name: string;
  readonly call: string;
}

/** What the guard knows of its run. */
interface Guard {
  /** Each call let through, by tool call id, until its result arrives. */
  readonly pending: HashMap.HashMap<string, Pending>;
  readonly streak: Option.Option<Streak>;
  readonly failing: Option.Option<FailureStreak>;
  readonly refused: boolean;
  /** The tool of a repeat refused a second time, which stops the run. */
  readonly stoppedAt: Option.Option<string>;
}

const unguarded: Guard = {
  pending: HashMap.empty(),
  streak: Option.none(),
  failing: Option.none(),
  refused: false,
  stoppedAt: Option.none(),
};

/** Why the guard refuses a call to `name` whose arguments are `args` as JSON, if it does. */
const refusalOf = (guard: Guard, name: string, args: string) =>
  Option.exists(
    guard.streak,
    (streak) => streak.call === `${name}\n${args}` && streak.count >= sameResultLimit,
  )
    ? Option.some(sameResultRefusal(name))
    : Option.exists(
          guard.failing,
          (failing) => failing.name === name && failing.count >= sameFailureLimit,
        )
      ? Option.some(sameFailureRefusal(name))
      : Option.none();

/** The guard's refusal of a call whose arguments are `args` as JSON, or none to let it through. */
const beforeCall = (
  guard: Guard,
  id: string,
  name: string,
  args: string,
): readonly [Option.Option<ToolFailureResult>, Guard] => {
  if (HashSet.has(waitingToolNames, name))
    return [Option.none(), { ...guard, streak: Option.none(), failing: Option.none() }];
  const refused = refusalOf(guard, name, args);
  return Option.isSome(refused)
    ? [
        refused,
        {
          ...guard,
          refused: true,
          stoppedAt: guard.refused ? Option.some(name) : guard.stoppedAt,
        },
      ]
    : [
        Option.none(),
        { ...guard, pending: HashMap.set(guard.pending, id, { name, call: `${name}\n${args}` }) },
      ];
};

/** The guard after a call it let through returned `outcome`, a failure when `failure` is some. */
const afterCall = (
  guard: Guard,
  id: string,
  outcome: string,
  failure: Option.Option<string>,
): Guard =>
  Option.match(HashMap.get(guard.pending, id), {
    onNone: () => guard,
    onSome: ({ name, call }) => ({
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
      failing: Option.map(failure, (failed) => ({
        name,
        failure: failed,
        count: Option.match(
          Option.filter(
            guard.failing,
            (failing) => failing.name === name && failing.failure === failed,
          ),
          { onNone: () => 1, onSome: (failing) => failing.count + 1 },
        ),
      })),
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

const outcomeOf = (answer: CallAnswer) =>
  Match.valueTags(answer, {
    Returned: ({ result }) => `ok\n${sameness(result)}`,
    Failed: ({ message }) => `error\n${message}`,
    Refused: ({ error }) => `error\n${error}`,
  });

/** Numbers left out, so process ids, times and counts in two reports of one failure match. */
const withoutNumbers = (text: string) => text.replaceAll(/\d+/g, "#");

/**
 * How a returned result failed, if it did: a command that did not succeed by its status, exit code
 * and output, or a result that reports an error. The command line is left out because it repeats
 * the arguments.
 */
const returnedFailure = (result: JsonValue) =>
  Option.match(decodeUnsucceeded(result), {
    onSome: ({ status, exitCode, stdout, stderr }) =>
      Option.some(`${status} ${exitCode}\n${stderr}\n${stdout}`),
    onNone: () => Option.map(decodeErrorResult(result), () => sameness(result)),
  });

/** How a call failed, numbers left out, or none when it did not. */
const failureOf = (answer: CallAnswer) =>
  Option.map(
    Match.valueTags(answer, {
      Returned: ({ result }) => returnedFailure(result),
      Failed: ({ message }) => Option.some(message),
      Refused: ({ error }) => Option.some(error),
    }),
    withoutNumbers,
  );

/**
 * Stops a model that repeats itself. A call that returned the same result three times in a row, or
 * a tool that failed the same way twenty times in a row whatever its arguments, is refused once
 * with a note saying so; a second refusal in the same run ends the run with
 * {@link RepeatedToolCall} before the next model call. A waiting tool never counts, and any other
 * call in between starts the count again. One hook serves one run.
 */
export const repeatGuardHook = Effect.map(Ref.make(unguarded), (guard): RunHook => ({
  admit: (_scope, call) =>
    Ref.modify(guard, (current) => {
      const [refused, next] = beforeCall(current, call.id, call.name, JSON.stringify(call.params));
      return [Option.map(refused, (result) => CallResult.Returned({ result })), next] as const;
    }),
  answered: (_scope, call, answer) =>
    Ref.update(guard, (current) =>
      afterCall(current, call.id, outcomeOf(answer), failureOf(answer)),
    ),
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
