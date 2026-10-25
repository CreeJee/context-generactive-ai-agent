import {
  isStandardSchema,
  parseWithStandardSchema,
  toolDefinition,
  validateJsonSchema,
  type AnyServerTool,
  type ToolExecutionContext,
} from "@tanstack/ai";
import { Context, Duration, Effect, HashSet, Layer, Option, Predicate, Schema } from "effect";
import {
  CodeSandbox,
  ProgramCallFailed,
  ProgramOutcome,
  type CodeSandboxFailed,
  type ProgramFunction,
} from "../code/sandbox.ts";
import { JsonValue } from "../json.ts";
import type { Project } from "../projects/projects.ts";
import { nativePromise, runNativeEffectWith } from "../runtime/native-effect.ts";
import { defaultTimeoutSeconds, maxTimeoutSeconds } from "../shell/run.ts";
import { CodeSkills, SavedProgram, type InputSchema } from "../skills/code-skills.ts";
import { isTruthy } from "../truthy.ts";
import { RunSkillInput } from "./definitions.ts";
import type { builtinToolEffects } from "./effects.ts";
import { guardedEffect, ToolFailed, toolFailedOf } from "./failure.ts";
import { toToolSchema } from "./schema.ts";

/** run_code's time: a program for the step at hand, unlike a skill's build or test run. */
const runCodeSeconds = { initial: 60, most: 600 };
/** A ts skill's time, as a sh skill's. */
const skillSeconds = { initial: defaultTimeoutSeconds, most: maxTimeoutSeconds };
const secondsOf = (asked: number | undefined, limits: { initial: number; most: number }) =>
  Duration.seconds(Math.min(Math.max(1, asked ?? limits.initial), limits.most));

const RunCodeInput = Schema.Struct({
  code: Schema.NonEmptyString.annotate({
    description: "The program: TypeScript, as the body of an async function.",
  }),
  timeoutSeconds: Schema.optionalKey(
    Schema.Int.annotate({
      description: `Stop the program after this long, waiting on its calls included. ${runCodeSeconds.initial} by default, at most ${runCodeSeconds.most}.`,
    }),
  ),
});

/**
 * Whether a program may call each built-in tool, beside what the run's permission mode asks about.
 * The tools that steer the run itself (its Goal and Plan, subagents, background tasks, delegation,
 * board edits, a card's verdict, memory adoption) stay with the model, which decides each call.
 */
const programCallable = {
  find_memory: true,
  read_evidence: true,
  trace_evidence: true,
  read_tool_result: true,
  promote_memory_candidate: false,
  use_promoted_memory: false,
  list_files: true,
  search_files: true,
  read_file: true,
  write_file: true,
  edit_file: true,
  delete_file: true,
  list_outside_files: true,
  read_outside_file: true,
  search_outside_file: true,
  write_outside_file: true,
  delete_outside_file: true,
  save_code_skill: true,
  run_skill: true,
  read_skill: true,
  kagi_search: true,
  kagi_extract: true,
  delegate_to_agent: false,
  get_background_result: false,
  cancel_background_task: false,
  run_subagent: false,
  resume_subagent: false,
  read_subagent_tool_result: true,
  get_subagent_reports: false,
  wait_subagents: false,
  adopt_subagent_reports: false,
  list_report_evidence: true,
  read_report_item: true,
  record_workflow_blocker: false,
  start_new_goal: false,
  update_goal: false,
  update_plan: false,
  close_plan: false,
  update_workflow_progress: false,
  read_kanban_board: true,
  edit_kanban_board: false,
  record_card_verdict: false,
  run_code: false,
} as const satisfies Record<keyof typeof builtinToolEffects, boolean>;

const notCallable = HashSet.fromIterable(
  Object.entries(programCallable).flatMap(([name, callable]) => (callable ? [] : [name])),
);

/** A tool is `external_<name>` in the program, so only a name that makes an identifier is offered. */
const identifierName = /^[A-Za-z0-9_]+$/;

const describe = (names: readonly string[]) =>
  [
    "Run a TypeScript program that calls your tools, for work that takes many calls of the tools you would pick anyway: loop over items, run calls at once with Promise.all, keep only what matters and return that.",
    "The code is the body of an async function: use await, and return a JSON value.",
    "Call a tool as `await external_<tool name>(input)` with the input that tool takes; it returns the tool's result, and a failed call throws an Error with the tool's message.",
    "console.log lines come back with the result. The program reaches nothing else: no files, network, processes, imports or timers.",
    "Tools that ask before they run are not available here; call those yourself.",
    names.length === 0
      ? "No tool can be called from a program in this run."
      : `Available: ${names.map((name) => `external_${name}`).join(", ")}.`,
  ].join(" ");

/**
 * What the model reads: how the program ended, and the lines it logged. A program that returned
 * nothing returned `null`.
 */
type RunCodeResult = { readonly logs: readonly string[] } & (
  | { readonly status: "returned"; readonly value: JsonValue }
  | { readonly status: "threw"; readonly error: string }
  | { readonly status: "timed_out" }
);

const decodeValue = Schema.decodeEffect(Schema.fromJsonString(JsonValue));

const resultOf = (outcome: ProgramOutcome) => {
  const logs =
    outcome.dropped === 0
      ? outcome.logs
      : [...outcome.logs, `(${outcome.dropped} more lines were not kept)`];
  return ProgramOutcome.match<Effect.Effect<RunCodeResult>>(outcome, {
    Returned: ({ value }) =>
      decodeValue(value ?? "null").pipe(
        // QuickJS's own JSON.stringify wrote it.
        Effect.orDie,
        Effect.map((decoded) => ({ status: "returned", value: decoded, logs })),
      ),
    Threw: ({ name, message, line }) =>
      Effect.succeed({
        status: "threw",
        error: line === undefined ? `${name}: ${message}` : `${name}: ${message} (line ${line})`,
        logs,
      }),
    TimedOut: () => Effect.succeed({ status: "timed_out", logs }),
  });
};

const sandboxProblems = {
  start: "The code sandbox did not start.",
  engine: "The code sandbox's engine did not load.",
  lost: "The code sandbox stopped before the program finished.",
} as const satisfies Record<CodeSandboxFailed["reason"], string>;

const sandboxFailure = ({ reason }: CodeSandboxFailed) =>
  ToolFailed.make({
    code: "sandbox_failed",
    tag: "CodeSandboxFailed",
    detail: sandboxProblems[reason],
  });

interface Callable {
  readonly name: string;
  readonly inputSchema: AnyServerTool["inputSchema"];
  readonly execute: NonNullable<AnyServerTool["execute"]>;
}

/**
 * The program's functions for one `run_code` call. Each call is checked against its tool's schema
 * as the chat engine checks the model's, gets an id below the program's own, and stops with it.
 */
const functionsFor = (tools: readonly Callable[], context: ToolExecutionContext | undefined) => {
  let calls = 0;
  const parent = context?.toolCallId ?? "run_code";
  return Object.fromEntries(
    tools.map(({ name, inputSchema, execute }): [string, ProgramFunction] => [
      name,
      (args) =>
        Effect.try({
          try: () =>
            isStandardSchema(inputSchema) ? parseWithStandardSchema(inputSchema, args) : args,
          catch: (error) =>
            ProgramCallFailed.make({
              message: `invalid_input: ${Predicate.isError(error) ? error.message : "The input does not match the tool's schema."}`,
            }),
        }).pipe(
          Effect.flatMap((input) =>
            Effect.tryPromise({
              // Promise boundary of the SDK's tools; the call's signal also ends with the program.
              try: (signal) =>
                Promise.resolve(
                  execute(input, {
                    ...context,
                    toolCallId: `${parent}#${++calls}`,
                    abortSignal: isTruthy(context?.abortSignal)
                      ? AbortSignal.any([context.abortSignal, signal])
                      : signal,
                    emitCustomEvent: () => undefined,
                  }),
                ),
              catch: (error) =>
                ProgramCallFailed.make({
                  message: Predicate.isError(error)
                    ? toolFailedOf(error).message
                    : "tool_failed: The call failed.",
                }),
            }),
          ),
        ),
    ]),
  );
};

const decodeRunSkill = Schema.decodeUnknownOption(RunSkillInput);
const decodeInput = Schema.decodeUnknownEffect(JsonValue);

const inputRejected = (detail: string) =>
  ToolFailed.make({ code: "invalid_input", tag: "SkillInputRejected", detail });

/** The input a ts skill gets: what run_skill was given, checked against the schema it declares. */
const skillInput = (
  schema: Option.Option<InputSchema>,
  input: NonNullable<(typeof RunSkillInput.Type)["input"]>,
): Effect.Effect<JsonValue, ToolFailed> =>
  Option.match(
    Option.flatMapNullishOr(schema, (declared) => validateJsonSchema(declared, input).issues),
    {
      onNone: () =>
        decodeInput(input).pipe(
          Effect.mapError(() => inputRejected("The input is not plain JSON.")),
        ),
      onSome: (issues) =>
        Effect.fail(inputRejected(issues.map((issue) => issue.message).join("; "))),
    },
  );

const make = Effect.gen(function* () {
  const sandbox = yield* CodeSandbox;
  const codeSkills = yield* CodeSkills;
  return {
    /**
     * Programs over a run's tools: `run_code`, and `codeSkills` to give a run_skill the ts skills.
     * A program may call each tool that runs without asking in this run (`asking` names those that
     * ask: approvals, reviews) and that does not steer the run.
     */
    forTools: (tools: readonly AnyServerTool[], asking: HashSet.HashSet<string>) =>
      Effect.map(Effect.context<never>(), (caller) => {
        const callable = tools.flatMap(({ name, inputSchema, execute, needsApproval }) =>
          isTruthy(execute) &&
          !isTruthy(needsApproval) &&
          !HashSet.has(asking, name) &&
          !HashSet.has(notCallable, name) &&
          identifierName.test(name)
            ? [{ name, inputSchema, execute }]
            : [],
        );
        const run = (
          code: string,
          input: JsonValue,
          timeout: Duration.Duration,
          context: ToolExecutionContext | undefined,
        ) =>
          sandbox
            .run({ code, input }, functionsFor(callable, context), timeout)
            .pipe(Effect.flatMap(resultOf), Effect.mapError(sandboxFailure));
        return {
          runCode: toolDefinition({
            name: "run_code",
            description: describe(callable.map(({ name }) => name)),
            inputSchema: toToolSchema(RunCodeInput),
          }).server(({ code, timeoutSeconds }, context) =>
            // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
            runNativeEffectWith(caller)(
              run(code, null, secondsOf(timeoutSeconds, runCodeSeconds), context),
              { signal: context?.abortSignal },
            ),
          ),

          /**
           * `runSkill` that also runs `project`'s ts skills, as programs over these tools, and its
           * sh skills as before. Any other tool comes back as it is.
           */
          codeSkills: (project: Project, runSkill: AnyServerTool): AnyServerTool => {
            const execute = runSkill.execute;
            if (runSkill.name !== "run_skill" || !isTruthy(execute)) return runSkill;
            return {
              ...runSkill,
              execute: (args, context?: ToolExecutionContext) =>
                Option.match(decodeRunSkill(args), {
                  // The engine checked the arguments; what it let through, the tool reports.
                  onNone: () => Promise.resolve(execute(args, context)),
                  onSome: ({ name, input = {}, timeoutSeconds }) =>
                    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
                    runNativeEffectWith(caller)(
                      guardedEffect(
                        name,
                        Effect.flatMap(codeSkills.runnable(project, name), (saved) =>
                          SavedProgram.$match(saved, {
                            sh: () => nativePromise(() => Promise.resolve(execute(args, context))),
                            ts: ({ code, input: schema }) =>
                              Effect.flatMap(skillInput(schema, input), (value) =>
                                run(code, value, secondsOf(timeoutSeconds, skillSeconds), context),
                              ),
                          }),
                        ),
                      ),
                      { signal: context?.abortSignal },
                    ),
                }),
            };
          },
        };
      }),
  };
});

/** Programs the model writes, which call the run's own tools from the code sandbox. */
export class CodeTools extends Context.Service<CodeTools, Effect.Success<typeof make>>()(
  "memory-agent/tools/code/CodeTools",
) {
  static readonly layer = Layer.effect(CodeTools, make).pipe(
    Layer.provide(CodeSandbox.layer),
    Layer.provide(CodeSkills.layer),
  );
}
