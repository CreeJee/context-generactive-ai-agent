import {
  Array as Arr,
  Cause,
  Clock,
  Crypto,
  Data,
  DateTime,
  Effect,
  Exit,
  Fiber,
  Function as EffectFunction,
  HashMap,
  HashSet,
  Match,
  Option,
  Predicate,
  Queue,
  Ref,
  Schema,
  Stream,
  SynchronizedRef,
} from "effect";
import {
  type AiError,
  type LanguageModel,
  Prompt,
  type Response,
  type Tool,
  Toolkit,
} from "effect/ai";
import type {
  MessageSource,
  StoredInterruptPayload,
  StoredMessage,
  StoredUsage,
} from "../chat-store/schema.ts";
import { JsonValue } from "../json.ts";
import { fromPrompt, optionsKey, PartOptions, toPrompt } from "../model/prompt.ts";
import { toolParameters } from "../model/tool-schema.ts";
import { optionalProperty } from "../optional-property.ts";
import { lazyToolsFor, ToolLookup } from "../tools/discovery.ts";
import { jsonSchemaIssues, prepareRepaired } from "../tools/input-repair.ts";
import type { RunTool } from "../tools/run-tool.ts";
import { serverRestartedCode, serverRestartedMessage } from "../agent/run-state.ts";
import type { AgUiEvent } from "./chunks.ts";
import { type ResumeEntry, type ResumeRejected, type Resumed, resumeAnswers } from "./resume.ts";
import {
  type Admission,
  type CallAnswer,
  CallOutcome,
  Run,
  type StepCall,
  stepScheduler,
} from "./scheduler.ts";
import { InterruptAnswer, RunEnd, RunStore } from "./store.ts";

/**
 * One chat run on Effect AI (docs/effect-ai-migration.md step 4): model steps until the model stops
 * calling tools, each step's calls run by the scheduler, the user asked where a call needs it, and
 * the run's rows kept as TanStack's persistence kept them. What the app adds to a run (queued
 * messages, permission review, memory records, compaction, …) comes in as hooks, which run in the
 * order they are listed.
 */

type AssistantMessage = Extract<StoredMessage, { readonly role: "assistant" }>;
type ToolMessage = Extract<StoredMessage, { readonly role: "tool" }> & { readonly content: string };
type Source = typeof MessageSource.Type;

/** A run that cannot go on; `message` is what the user sees and the run row keeps. */
export class RunFailed extends Schema.TaggedError<RunFailed>()("RunFailed", {
  message: Schema.String,
  code: Schema.optionalKey(Schema.String),
}) {}

/** The run a hook works for. */
export interface RunScope {
  readonly threadId: string;
  readonly runId: string;
  /** Streams an event of the app's own, such as a `CUSTOM` one, to the page. */
  readonly emit: (event: AgUiEvent) => Effect.Effect<void>;
}

/** What one model step is asked with. */
export interface StepRequest {
  readonly system: ReadonlyArray<string>;
  readonly history: ReadonlyArray<StoredMessage>;
}

/** A call and the answer it got. */
export interface AnsweredCall {
  readonly call: StepCall;
  readonly answer: CallAnswer;
}

/** A step that ended, with the message whose calls it ran and the calls that got answers. */
export type StepEnded = Data.TaggedEnum<{
  /** The model wrote `message` in this step. */
  Model: { readonly message: AssistantMessage; readonly answered: ReadonlyArray<AnsweredCall> };
  /** A resume run answered calls that `message`, written by an earlier run, made. */
  Resume: { readonly message: AssistantMessage; readonly answered: ReadonlyArray<AnsweredCall> };
}>;
export const StepEnded = Data.taggedEnum<StepEnded>();

/** What the app adds to a run. Every member is optional; hooks run in the order they are listed. */
export interface RunHook<R = never> {
  /** Before the first step; `resumed` holds the answers a resume run brings, else nothing. */
  readonly started?: (
    scope: RunScope,
    resumed: ReadonlyArray<Resumed>,
  ) => Effect.Effect<void, RunFailed, R>;
  /** Before each model step: messages that join the conversation, such as queued user messages. */
  readonly joining?: (
    scope: RunScope,
    conversation: ReadonlyArray<StoredMessage>,
  ) => Effect.Effect<ReadonlyArray<StoredMessage>, RunFailed, R>;
  /** The request of a model step, from what the hooks before this one made of it. */
  readonly request?: (
    scope: RunScope,
    request: StepRequest,
  ) => Effect.Effect<StepRequest, RunFailed, R>;
  /**
   * A gate for a call whose arguments fit its tool: its decision, or none to let the next gate
   * decide. A call that every gate lets through runs. `written` is the arguments as the model wrote
   * them, which the stored message keeps.
   */
  readonly admit?: (
    scope: RunScope,
    call: StepCall,
    written: string,
  ) => Effect.Effect<Option.Option<Admission<StoredInterruptPayload>>, RunFailed, R>;
  /** A call got its answer, as soon as it did. */
  readonly answered?: (
    scope: RunScope,
    call: StepCall,
    answer: CallAnswer,
  ) => Effect.Effect<void, RunFailed, R>;
  /**
   * What a model call used, as the provider reported it: a count it did not report is absent, not
   * zero.
   */
  readonly usage?: (
    scope: RunScope,
    usage: Response.Usage,
    source: Source,
  ) => Effect.Effect<void, RunFailed, R>;
  /** A step ended and its calls that do not wait for the user got their answers. */
  readonly stepEnded?: (scope: RunScope, step: StepEnded) => Effect.Effect<void, RunFailed, R>;
  /** The run goes on to another model step; a failure stops it instead. */
  readonly continues?: (
    scope: RunScope,
    conversation: ReadonlyArray<StoredMessage>,
  ) => Effect.Effect<void, RunFailed, R>;
  /** The run ended, or waits for the user, with its conversation as saved. */
  readonly ended?: (
    scope: RunScope,
    end: RunEnd,
    conversation: ReadonlyArray<StoredMessage>,
  ) => Effect.Effect<void, never, R>;
}

/** How a run works: the model and tools it uses and what the app adds. */
export interface RunSpec<R> {
  readonly model: LanguageModel.LanguageModel;
  /** Written on every message the model writes; replay compares it with the model it sends to. */
  readonly source: Source;
  readonly system: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<RunTool>;
  readonly hooks: ReadonlyArray<RunHook<R>>;
  /** A failed model call as the user sees it, which never shows a provider's text. */
  readonly modelFailure: (error: AiError.AiError | Schema.SchemaError) => RunFailed;
}

/** What a run is for. */
export interface RunInput {
  readonly threadId: string;
  readonly runId: string;
  /** The conversation so far with the user's new messages, merged by the caller. */
  readonly conversation: ReadonlyArray<StoredMessage>;
  /** The answers to the interrupts the thread waits on; empty when it waits on none. */
  readonly resume: ReadonlyArray<ResumeEntry>;
  /** Completes when the user cancels the run. */
  readonly cancel: Effect.Effect<void>;
}

/** The user's decision on a call that needed approval. */
type Approval = Data.TaggedEnum<{
  Approved: { readonly editedArgs: Option.Option<JsonValue> };
  Declined: {};
  Cancelled: {};
}>;
const Approval = Data.taggedEnum<Approval>();

const approvalOf = InterruptAnswer.$match({
  Resolved: ({ response }) =>
    response.approved
      ? Approval.Approved({ editedArgs: Option.fromNullishOr(response.editedArgs) })
      : Approval.Declined(),
  Cancelled: () => Approval.Cancelled(),
});

/** Each approval the resume answers, by the call it is for. */
const approvalsOf = (resumed: ReadonlyArray<Resumed>) =>
  HashMap.fromIterable(
    resumed.flatMap(({ interrupt: { payload }, answer }) =>
      payload.reason === "tool_call" ? [[payload.toolCallId, approvalOf(answer)] as const] : [],
    ),
  );

/** What comes after a step. */
type Next = Data.TaggedEnum<{
  /** Calls wait for the user; the run waits with them. */
  Interrupt: { readonly waiting: Arr.NonEmptyReadonlyArray<StoredInterruptPayload> };
  Continue: {};
  Finish: {};
}>;
const Next = Data.taggedEnum<Next>();

interface StepOutcome {
  readonly conversation: ReadonlyArray<StoredMessage>;
  readonly next: Next;
}

/** A call answered before its tool runs: the answer short-circuits the rest of its admission. */
class Decided extends Data.TaggedError("Decided")<{
  readonly admission: Admission<StoredInterruptPayload>;
}> {}

const decided = (admission: Admission<StoredInterruptPayload>) =>
  Effect.fail(new Decided({ admission }));

/** A call that never reaches its tool, as TanStack answered it: the failure text as its result. */
const refused = (message: string) =>
  decided(CallOutcome.Refused({ result: { error: message }, message }));

/** The arguments of a call as the model sent them. */
interface SentArguments {
  /** Trimmed, and `{}` for none, as TanStack quoted them. */
  readonly text: string;
  readonly parsed: boolean;
}

/** A call as the scheduler gets it, with what its admission needs to know. */
interface OfferedCall {
  readonly call: StepCall;
  /** The arguments as the model wrote them. */
  readonly written: string;
  readonly sent: SentArguments;
  /** The user's approval changed the arguments. */
  readonly edited: boolean;
}

const decodeJson = Schema.decodeOption(Schema.fromJsonString(JsonValue));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(JsonValue));
const encodeParams = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodePartOptions = Schema.decodeUnknownOption(PartOptions);
const asJson = Schema.decodeUnknownEffect(JsonValue);

/** At most this many problems of a call's arguments are listed. */
const listedIssues = 10;

const issueList = (issues: ReadonlyArray<string>) =>
  [
    ...issues.slice(0, listedIssues),
    ...(issues.length > listedIssues ? [`and ${issues.length - listedIssues} more`] : []),
  ].join(", ");

/** What the model reads for arguments its tool refused, as TanStack wrote it. */
const invalidInput = (
  tool: RunTool,
  { call, sent, edited }: OfferedCall,
  error: Schema.SchemaError,
) =>
  [
    `Input validation failed for tool ${call.name}: ${issueList(
      Option.getOrElse(
        jsonSchemaIssues({ schema: toolParameters(tool.tool), value: call.params }),
        () => [error.message],
      ),
    )}`,
    `Received arguments: ${sent.text}`,
    ...(edited
      ? [
          "An approval edit or middleware changed these arguments before the check. The changed input failed the check.",
        ]
      : []),
  ].join("\n");

/** The interrupt that asks the user to approve a call of a tool that needs it. */
const approvalRequest = (call: StepCall, tool: RunTool) =>
  Effect.map(asJson(toolParameters(tool.tool)), (editedArgs): StoredInterruptPayload => ({
    id: `approval_${call.id}`,
    reason: "tool_call",
    message: `Approval required to run ${call.name}`,
    toolCallId: call.id,
    responseSchema: {
      oneOf: [
        {
          type: "object",
          properties: { approved: { const: true }, editedArgs },
          required: ["approved"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { approved: { const: false } },
          required: ["approved"],
          additionalProperties: false,
        },
      ],
    },
    metadata: { kind: "approval", toolName: call.name, input: call.params },
  }));

/** A result as a tool message carries it: text as it is, anything else as JSON. */
const contentOf = (result: JsonValue) =>
  Predicate.isString(result) ? Effect.succeed(result) : encodeJson(result);

const toolMessage = ({ call, answer }: AnsweredCall) => {
  const failed = ({ result, message }: { readonly result: JsonValue; readonly message: string }) =>
    Effect.map(contentOf(result), (content): ToolMessage => ({
      role: "tool",
      toolCallId: call.id,
      content,
      error: message,
    }));
  return Match.valueTags(answer, {
    Returned: ({ result }) =>
      Effect.map(contentOf(result), (content): ToolMessage => ({
        role: "tool",
        toolCallId: call.id,
        content,
      })),
    Failed: failed,
    Refused: failed,
  });
};

/** Calls in the order the model made them, split into those answered and those that wait. */
const sorted = (
  calls: ReadonlyArray<StepCall>,
  outcomes: ReadonlyArray<CallOutcome<StoredInterruptPayload>>,
) => {
  const pairs = Arr.zip(calls, outcomes);
  return {
    answered: pairs.flatMap(([call, outcome]) =>
      Match.valueTags(outcome, {
        Waiting: (): ReadonlyArray<AnsweredCall> => [],
        Returned: (answer) => [{ call, answer }],
        Failed: (answer) => [{ call, answer }],
        Refused: (answer) => [{ call, answer }],
      }),
    ),
    waiting: pairs.flatMap(([, outcome]) =>
      CallOutcome.$is("Waiting")(outcome) ? [outcome.request] : [],
    ),
  };
};

/** Finish reasons a stored message keeps, by the name Effect AI gives them. */
const storedFinishReasons = {
  stop: "stop",
  length: "length",
  "content-filter": "content_filter",
  "tool-calls": "tool_calls",
} as const;
const isStoredFinishReason = Schema.is(
  Schema.Literals(["stop", "length", "content-filter", "tool-calls"]),
);

/** The finish reason a stored message keeps, if it keeps this one. */
const storedFinishReason = ({ reason }: Response.FinishPart) =>
  Option.map(
    Option.liftPredicate(reason, isStoredFinishReason),
    (kept) => storedFinishReasons[kept],
  );

/** A finish after which the response is whole, so its writes may run. */
const isComplete = Schema.is(Schema.Literals(["stop", "tool-calls", "pause"]));

/** What a model call used, with every count filled in; none when the provider reported none. */
const usageOf = ({ inputTokens, outputTokens }: Response.Usage): Option.Option<StoredUsage> =>
  inputTokens.total === undefined && outputTokens.total === undefined
    ? Option.none()
    : Option.some({
        inputTokens: inputTokens.total ?? 0,
        outputTokens: outputTokens.total ?? 0,
        totalTokens: (inputTokens.total ?? 0) + (outputTokens.total ?? 0),
        cachedInputTokens: inputTokens.cacheRead ?? 0,
        cacheWriteInputTokens: inputTokens.cacheWrite ?? 0,
        reasoningTokens: outputTokens.reasoning ?? 0,
      });

const countedKeys = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "reasoningTokens",
] as const;

/** The run's usage with a model call's added. */
const addUsage = (total: Option.Option<StoredUsage>, step: StoredUsage): StoredUsage =>
  Option.match(total, {
    onNone: () => step,
    onSome: (counted) =>
      Object.fromEntries(
        countedKeys.map((key) => [key, (counted[key] ?? 0) + (step[key] ?? 0)] as const),
      ),
  });

/** What a step's stream gave so far. */
interface Streamed {
  readonly parts: ReadonlyArray<Response.AnyPart>;
  /** The text streamed so far, which a cut step keeps as its partial answer. */
  readonly text: string;
  /** The calls offered to the scheduler, in the order the model made them. */
  readonly calls: ReadonlyArray<StepCall>;
  /** Calls whose arguments streamed as they were written. */
  readonly streamedArguments: HashSet.HashSet<string>;
  readonly lastSnapshot: Option.Option<number>;
}

const nothingStreamed: Streamed = {
  parts: [],
  text: "",
  calls: [],
  streamedArguments: HashSet.empty(),
  lastSnapshot: Option.none(),
};

/** A streamed answer is saved at most this often while it is written. */
const snapshotIntervalMs = 1_000;

const isAssistant = (message: StoredMessage): message is AssistantMessage =>
  message.role === "assistant";
const isToolMessage = (
  message: StoredMessage,
): message is Extract<StoredMessage, { readonly role: "tool" }> => message.role === "tool";

/**
 * The conversation with `added` tool messages joined to those that follow `assistant`, all of them
 * in the order of its calls.
 */
const placed = (
  conversation: ReadonlyArray<StoredMessage>,
  assistant: AssistantMessage,
  added: ReadonlyArray<StoredMessage>,
) => {
  const at = conversation.indexOf(assistant) + 1;
  const [results, rest] = Arr.span(conversation.slice(at), isToolMessage);
  const all = [...results, ...added.filter(isToolMessage)];
  return [
    ...conversation.slice(0, at),
    ...(assistant.toolCalls ?? []).flatMap((call) =>
      all.filter((message) => message.toolCallId === call.id),
    ),
    ...rest,
  ];
};

/** A tool as a step lists it to the provider, which needs no services to describe it. */
type ListedTool = Tool.Tool<
  string,
  {
    readonly parameters: typeof Schema.Unknown;
    readonly success: typeof Schema.Unknown;
    readonly failure: typeof Schema.Unknown;
    readonly failureMode: Tool.FailureMode;
  },
  never
>;

/**
 * The toolkit a step offers. It only lists the tools to the provider: the loop resolves no call
 * through it, so none of the services `Tool.Any` leaves open is ever asked for.
 */
const toolkitOf = (tools: ReadonlyArray<RunTool>) =>
  Toolkit.make(
    // SAFETY: with `disableToolCallResolution` no handler runs and no arguments are encoded.
    ...tools.map(({ tool }) => tool as ListedTool),
  );

const isRunFailed = Schema.is(RunFailed);

/** A failure as the run fails with it: its own message, which the run row keeps. */
export const asRunFailed = (error: { readonly message: string }) =>
  isRunFailed(error) ? error : RunFailed.make({ message: error.message });

/** The run after its resume was accepted: it starts, goes on until it ends, and keeps its rows. */
const runAccepted = Effect.fnUntraced(function* <R>(
  spec: RunSpec<R>,
  input: RunInput,
  emit: (event: AgUiEvent) => Effect.Effect<void>,
  resumed: ReadonlyArray<Resumed>,
) {
  const store = yield* RunStore;
  const crypto = yield* Crypto.Crypto;
  const { threadId, runId } = input;
  const run = { threadId, runId };
  const scope: RunScope = { threadId, runId, emit };
  const hooks = spec.hooks;
  const tools = yield* lazyToolsFor(spec.tools, input.conversation);
  const approvals = approvalsOf(resumed);
  const conversation = yield* Ref.make(input.conversation);
  /** The answer being written, which a cut run keeps. */
  const partial = yield* Ref.make(Option.none<AssistantMessage>());
  const usage = yield* Ref.make(Option.none<StoredUsage>());

  const answered = (call: StepCall, answer: CallAnswer) =>
    Effect.forEach(
      hooks.flatMap((hook) => hook.answered ?? []),
      (hook) => hook(scope, call, answer),
      { discard: true },
    );

  const stepEnded = (step: StepEnded) =>
    Effect.forEach(
      hooks.flatMap((hook) => hook.stepEnded ?? []),
      (hook) => hook(scope, step),
      { discard: true },
    );

  const ended = (end: RunEnd, saved: ReadonlyArray<StoredMessage>) =>
    Effect.forEach(
      hooks.flatMap((hook) => hook.ended ?? []),
      (hook) => hook(scope, end, saved),
      { discard: true },
    );

  /** The call the model made, with the arguments the user's approval edited, if it did. */
  const offeredCall = (id: string, name: string, written: string): OfferedCall => {
    const text = written.trim() || "{}";
    const parsed = decodeJson(text);
    const edits = Option.flatMap(
      HashMap.get(approvals, id),
      Approval.$match({
        Approved: ({ editedArgs }) => editedArgs,
        Declined: Option.none<JsonValue>,
        Cancelled: Option.none<JsonValue>,
      }),
    );
    const sentParams = Option.match(parsed, {
      onNone: (): JsonValue => ({}),
      onSome: (params) => (Predicate.isObject(params) ? params : {}),
    });
    return {
      call: { id, name, params: Option.getOrElse(edits, () => sentParams) },
      written,
      sent: { text, parsed: Option.isSome(parsed) },
      edited: Option.isSome(edits),
    };
  };

  /** Whether the call runs, in the order TanStack decided it, then the hooks' gates. */
  const admission = (offered: OfferedCall) => {
    const { call, written, sent } = offered;
    const approval = HashMap.get(approvals, call.id);
    return Effect.gen(function* () {
      const tool = yield* Effect.flatMap(
        tools.find(call.name),
        ToolLookup.$match({
          Found: ({ tool }) => Effect.succeed(tool),
          Undiscovered: ({ message }) => refused(message),
          Unknown: () => refused(`Unknown tool: ${call.name}`),
        }),
      );
      yield* Effect.when(
        refused("Tool execution cancelled"),
        Effect.succeed(Option.exists(approval, Approval.$is("Cancelled"))),
      );
      yield* Effect.when(
        refused(`Failed to parse tool arguments as JSON: ${sent.text}`),
        Effect.succeed(!sent.parsed),
      );
      yield* Effect.when(
        refused("User declined tool execution"),
        Effect.succeed(Option.exists(approval, Approval.$is("Declined"))),
      );
      const prepared = yield* prepareRepaired(tool)(call.params).pipe(
        Effect.catch((error) => refused(invalidInput(tool, offered, error))),
      );
      yield* Effect.when(
        Effect.flatMap(approvalRequest(call, tool), (request) =>
          decided(CallOutcome.Waiting({ request })),
        ),
        Effect.succeed(tool.tool.needsApproval === true && Option.isNone(approval)),
      );
      yield* Effect.forEach(
        hooks.flatMap((hook) => hook.admit ?? []),
        (gate) =>
          Effect.flatMap(
            gate(scope, call, written),
            Option.match({ onNone: () => Effect.void, onSome: decided }),
          ),
        { discard: true },
      );
      return Run(prepared({ toolCallId: call.id }));
    }).pipe(
      Effect.catchTag("Decided", ({ admission }) =>
        Effect.succeed<Admission<StoredInterruptPayload>>(admission),
      ),
      Effect.mapError(asRunFailed),
    );
  };

  /** Streams each answered call's result, in call order, and gives their tool messages. */
  const results = (calls: ReadonlyArray<AnsweredCall>) =>
    Effect.forEach(calls, (answeredCall) =>
      Effect.gen(function* () {
        const message = yield* toolMessage(answeredCall);
        yield* emit({
          type: "TOOL_CALL_RESULT",
          messageId: yield* crypto.randomUUIDv7(),
          toolCallId: message.toolCallId,
          content: message.content,
          role: "tool",
        });
        return message;
      }),
    );

  /**
   * A resume run first gives an answer to each call of the last assistant message that has none:
   * the user's answers decide those that waited, and the gates see them again.
   */
  const resumeStep = Effect.fnUntraced(
    function* (current: ReadonlyArray<StoredMessage>) {
      const last = Arr.findLast(current, isAssistant);
      const answeredIds = HashSet.fromIterable(
        current.flatMap((message) => (isToolMessage(message) ? [message.toolCallId] : [])),
      );
      const offered = Option.match(last, {
        onNone: () => [],
        onSome: (assistant) => assistant.toolCalls ?? [],
      })
        .filter((call) => !HashSet.has(answeredIds, call.id))
        .map((call) => offeredCall(call.id, call.function.name, call.function.arguments));
      const scheduler = yield* stepScheduler<StoredInterruptPayload, RunFailed, R>({ answered });
      yield* Effect.forEach(offered, (call) => scheduler.offer(call.call, admission(call)), {
        discard: true,
      });
      // The response that made these calls finished long ago.
      const outcome = sorted(
        offered.map(({ call }) => call),
        yield* scheduler.settle(true),
      );
      const added = yield* results(outcome.answered);
      const next = Option.match(last, {
        onNone: () => [...current, ...added],
        onSome: (assistant) => placed(current, assistant, added),
      });
      yield* Ref.set(conversation, next);
      yield* Effect.transposeOption(
        Option.map(last, (message) =>
          stepEnded(StepEnded.Resume({ message, answered: outcome.answered })),
        ),
      );
      return {
        conversation: next,
        next: Arr.match(outcome.waiting, {
          onEmpty: () => Next.Continue(),
          onNonEmpty: (waiting) => Next.Interrupt({ waiting }),
        }),
      } satisfies StepOutcome;
    },
    Effect.scoped,
    Effect.mapError(asRunFailed),
  );

  /** One model step: its events streamed, its calls run, its message and results kept. */
  const modelStep = Effect.fnUntraced(
    function* (before: ReadonlyArray<StoredMessage>) {
      const current = yield* Effect.reduce(
        hooks.flatMap((hook) => hook.joining ?? []),
        () => before,
        (messages, joining) =>
          Effect.map(joining(scope, messages), (added) => [...messages, ...added]),
      );
      yield* Ref.set(conversation, current);
      const request = yield* Effect.reduce(
        hooks.flatMap((hook) => hook.request ?? []),
        (): StepRequest => ({ system: spec.system, history: current }),
        (sent, hook) => hook(scope, sent),
      );
      const offeredTools = yield* tools.offered;
      const messageId = yield* crypto.randomUUIDv7();
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const scheduler = yield* stepScheduler<StoredInterruptPayload, RunFailed, R>({ answered });
      const streamed = yield* SynchronizedRef.make(nothingStreamed);

      const writing = (state: Streamed, delta: string) =>
        Effect.gen(function* () {
          const text = state.text + delta;
          yield* emit({ type: "TEXT_MESSAGE_CONTENT", messageId, delta });
          const answer: AssistantMessage = {
            role: "assistant",
            id: messageId,
            createdAt,
            content: text,
            source: spec.source,
          };
          yield* Ref.set(partial, Option.some(answer));
          const now = yield* Clock.currentTimeMillis;
          const due = Option.match(state.lastSnapshot, {
            onNone: () => true,
            onSome: (at) => now - at >= snapshotIntervalMs,
          });
          // A reload while the answer is written shows what was written so far.
          yield* Effect.when(
            store.saveThread(threadId, [...current, answer]).pipe(Effect.ignore({ log: "Warn" })),
            Effect.succeed(due),
          );
          return { ...state, text, lastSnapshot: due ? Option.some(now) : state.lastSnapshot };
        });

      const called = (state: Streamed, part: Response.ToolCallPart<string, unknown>) =>
        Effect.gen(function* () {
          const written = Option.getOrElse(
            Option.flatMap(decodePartOptions(part.metadata[optionsKey]), (options) =>
              Option.fromNullishOr(options.arguments),
            ),
            () => Option.getOrElse(encodeParams(part.params), () => "{}"),
          );
          // A provider that sends the arguments whole streams them here as one piece.
          yield* Effect.when(
            Effect.forEach(
              [
                {
                  type: "TOOL_CALL_START",
                  toolCallId: part.id,
                  toolCallName: part.name,
                  parentMessageId: messageId,
                },
                { type: "TOOL_CALL_ARGS", toolCallId: part.id, delta: written },
                { type: "TOOL_CALL_END", toolCallId: part.id },
              ] as const,
              emit,
              { discard: true },
            ),
            Effect.succeed(!HashSet.has(state.streamedArguments, part.id)),
          );
          const offered = offeredCall(part.id, part.name, written);
          yield* scheduler.offer(offered.call, admission(offered));
          return { ...state, calls: [...state.calls, offered.call] };
        });

      const reasoningId = (id: string) => `${messageId}:${id}`;
      const onPart = (state: Streamed, part: Response.AnyPart) => {
        const kept: Streamed = { ...state, parts: [...state.parts, part] };
        const emitted = (...events: ReadonlyArray<AgUiEvent>) =>
          Effect.as(Effect.forEach(events, emit, { discard: true }), kept);
        return Match.value(part).pipe(
          Match.discriminators("type")({
            "text-start": () =>
              emitted({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" }),
            "text-delta": ({ delta }) => writing(kept, delta),
            "text-end": () => emitted({ type: "TEXT_MESSAGE_END", messageId }),
            "reasoning-start": ({ id }) =>
              emitted(
                { type: "REASONING_START", messageId: reasoningId(id) },
                { type: "REASONING_MESSAGE_START", messageId: reasoningId(id), role: "reasoning" },
              ),
            "reasoning-delta": ({ id, delta }) =>
              emitted({ type: "REASONING_MESSAGE_CONTENT", messageId: reasoningId(id), delta }),
            "reasoning-end": ({ id }) =>
              emitted(
                { type: "REASONING_MESSAGE_END", messageId: reasoningId(id) },
                { type: "REASONING_END", messageId: reasoningId(id) },
              ),
            "tool-params-start": ({ id, name }) =>
              Effect.as(
                emit({
                  type: "TOOL_CALL_START",
                  toolCallId: id,
                  toolCallName: name,
                  parentMessageId: messageId,
                }),
                { ...kept, streamedArguments: HashSet.add(kept.streamedArguments, id) },
              ),
            "tool-params-delta": ({ id, delta }) =>
              emitted({ type: "TOOL_CALL_ARGS", toolCallId: id, delta }),
            "tool-params-end": ({ id }) => emitted({ type: "TOOL_CALL_END", toolCallId: id }),
            // A call the provider ran is part of the message only.
            "tool-call": (call) =>
              call.providerExecuted === true ? Effect.succeed(kept) : called(kept, call),
          }),
          Match.orElse(() => Effect.succeed(kept)),
        );
      };

      yield* spec.model
        .streamText({
          prompt: toPrompt(request.history, request.system),
          toolkit: toolkitOf(offeredTools),
          disableToolCallResolution: true,
          toolCallValidation: "deferred",
        })
        .pipe(
          Stream.mapError(spec.modelFailure),
          Stream.runForEach((part) =>
            SynchronizedRef.updateEffect(streamed, (state) => onPart(state, part)),
          ),
        );

      const done = yield* SynchronizedRef.get(streamed);
      const finish = Arr.findFirst(
        done.parts,
        (part): part is Response.FinishPart => part.type === "finish",
      );
      const model = Arr.findFirst(done.parts, (part) =>
        part.type === "response-metadata" ? Option.fromNullishOr(part.modelId) : Option.none(),
      );
      const outcome = sorted(
        done.calls,
        yield* scheduler.settle(Option.exists(finish, ({ reason }) => isComplete(reason))),
      );
      const message = Option.map(
        Arr.findFirst(fromPrompt(Prompt.fromResponseParts(done.parts)).history, isAssistant),
        ({ content, thinking, ...written }): AssistantMessage => {
          // A provider may open a thinking block it never writes; replay has nothing to send.
          const kept = (thinking ?? []).filter(
            (block) => block.content !== "" || block.signature !== undefined,
          );
          return {
            ...written,
            id: messageId,
            createdAt,
            content: content ?? null,
            ...optionalProperty("thinking", Arr.isReadonlyArrayNonEmpty(kept) ? kept : undefined),
            model: Option.getOrElse(model, () => spec.source.model),
            source: spec.source,
            ...optionalProperty(
              "finishReason",
              Option.getOrUndefined(Option.flatMap(finish, storedFinishReason)),
            ),
          };
        },
      );
      const added = yield* results(outcome.answered);
      const next = [...current, ...Option.toArray(message), ...added];
      yield* Ref.set(conversation, next);
      yield* Ref.set(partial, Option.none());

      yield* Effect.transposeOption(
        Option.flatMap(finish, (part) =>
          Option.map(usageOf(part.usage), (used) =>
            Ref.update(usage, (total) => Option.some(addUsage(total, used))).pipe(
              Effect.andThen(
                Effect.forEach(
                  hooks.flatMap((hook) => hook.usage ?? []),
                  (hook) => hook(scope, part.usage, spec.source),
                  { discard: true },
                ),
              ),
            ),
          ),
        ),
      );
      yield* Effect.transposeOption(
        Option.map(message, (written) =>
          stepEnded(StepEnded.Model({ message: written, answered: outcome.answered })),
        ),
      );
      return {
        conversation: next,
        next: Arr.match(outcome.waiting, {
          onEmpty: () =>
            Option.exists(finish, ({ reason }) => reason === "tool-calls")
              ? Next.Continue()
              : Next.Finish(),
          onNonEmpty: (waiting) => Next.Interrupt({ waiting }),
        }),
      } satisfies StepOutcome;
    },
    Effect.scoped,
    Effect.mapError(asRunFailed),
  );

  const commitResumes = store.commitInterrupts(resumed.map(({ answer }) => answer));

  /** The run waits for the user: its interrupts are asked and its rows saved. */
  const interrupted = (
    saved: ReadonlyArray<StoredMessage>,
    waiting: Arr.NonEmptyReadonlyArray<StoredInterruptPayload>,
  ) =>
    Effect.gen(function* () {
      yield* commitResumes;
      yield* store.createInterrupts(run, waiting);
      yield* store.endRun(runId, RunEnd.Interrupted(), yield* Ref.get(usage));
      yield* store.saveThread(threadId, saved);
      yield* ended(RunEnd.Interrupted(), saved);
      yield* emit({
        type: "RUN_FINISHED",
        threadId,
        runId,
        outcome: { type: "interrupt", interrupts: waiting },
      });
    }).pipe(Effect.mapError(asRunFailed), Effect.uninterruptible);

  const finished = (saved: ReadonlyArray<StoredMessage>) =>
    Effect.gen(function* () {
      yield* store.saveThread(threadId, saved);
      yield* commitResumes;
      yield* store.endRun(runId, RunEnd.Completed(), yield* Ref.get(usage));
      yield* ended(RunEnd.Completed(), saved);
      yield* emit({ type: "RUN_FINISHED", threadId, runId });
    }).pipe(Effect.mapError(asRunFailed), Effect.uninterruptible);

  const after = (outcome: StepOutcome): Effect.Effect<void, RunFailed, R> =>
    Next.$match(outcome.next, {
      Interrupt: ({ waiting }) => interrupted(outcome.conversation, waiting),
      Continue: () =>
        Effect.forEach(
          hooks.flatMap((hook) => hook.continues ?? []),
          (hook) => hook(scope, outcome.conversation),
          { discard: true },
        ).pipe(Effect.andThen(modelStep(outcome.conversation)), Effect.flatMap(after)),
      Finish: () => finished(outcome.conversation),
    });

  /** The conversation as it was when the run stopped, with the answer it was writing. */
  const stoppedAt = (stopReason: "error" | "aborted", end: RunEnd) =>
    Effect.gen(function* () {
      const saved = [
        ...(yield* Ref.get(conversation)),
        ...Option.toArray(
          Option.map(yield* Ref.get(partial), (answer): AssistantMessage => ({
            ...answer,
            stopReason,
          })),
        ),
      ];
      yield* store.saveThread(threadId, saved);
      yield* store.endRun(runId, end, yield* Ref.get(usage));
      yield* ended(end, saved);
    }).pipe(Effect.ignore({ log: "Warn" }));

  const failedWith = (failure: RunFailed) =>
    Effect.gen(function* () {
      yield* stoppedAt(
        "error",
        RunEnd.Failed({ message: failure.message, code: Option.fromNullishOr(failure.code) }),
      );
      yield* emit({
        type: "RUN_ERROR",
        message: failure.message,
        ...optionalProperty("code", failure.code),
      });
    });

  const aborted = stoppedAt("aborted", RunEnd.Aborted()).pipe(
    Effect.andThen(emit({ type: "RUN_FINISHED", threadId, runId, outcome: { type: "cancelled" } })),
  );

  /** The user cancelled the run. A run interrupted without it was stopped by the server. */
  const cancelled = yield* Ref.make(false);

  const stopped = (cause: Cause.Cause<RunFailed>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.flatMap(Ref.get(cancelled), (byUser) =>
          byUser
            ? aborted
            : failedWith(
                RunFailed.make({ message: serverRestartedMessage, code: serverRestartedCode }),
              ),
        )
      : failedWith(
          Option.getOrElse(Cause.findErrorOption(cause), () =>
            RunFailed.make({ message: "The run stopped unexpectedly." }),
          ),
        );

  const running = Effect.gen(function* () {
    yield* Ref.set(usage, yield* store.startRun(run));
    yield* emit({
      type: "RUN_STARTED",
      threadId,
      runId,
      ...optionalProperty(
        "parentRunId",
        Option.getOrUndefined(Option.map(Arr.head(resumed), ({ interrupt }) => interrupt.runId)),
      ),
    });
    yield* store.saveThread(threadId, input.conversation);
    yield* Effect.forEach(
      hooks.flatMap((hook) => hook.started ?? []),
      (hook) => hook(scope, resumed),
      { discard: true },
    );
    const first = Arr.isReadonlyArrayNonEmpty(resumed)
      ? yield* resumeStep(input.conversation)
      : yield* modelStep(input.conversation);
    yield* after(first);
  }).pipe(
    Effect.mapError(asRunFailed),
    Effect.onExit(Exit.match({ onSuccess: () => Effect.void, onFailure: stopped })),
  );

  const fiber = yield* Effect.forkChild(running);
  yield* Effect.forkChild(
    input.cancel.pipe(
      Effect.andThen(Ref.set(cancelled, true)),
      Effect.andThen(Fiber.interrupt(fiber)),
    ),
  );
  yield* Fiber.await(fiber);
});

/**
 * The events of a run, which keeps its rows as it goes. A resume the pending interrupts refuse
 * streams only its `RUN_ERROR` and starts no run.
 */
export const runChat: {
  (
    input: RunInput,
  ): <R>(spec: RunSpec<R>) => Stream.Stream<AgUiEvent, never, R | RunStore | Crypto.Crypto>;
  <R>(
    spec: RunSpec<R>,
    input: RunInput,
  ): Stream.Stream<AgUiEvent, never, R | RunStore | Crypto.Crypto>;
} = EffectFunction.dual(2, runChatBody);
function runChatBody<R>(
  spec: RunSpec<R>,
  input: RunInput,
): Stream.Stream<AgUiEvent, never, R | RunStore | Crypto.Crypto> {
  return Stream.callback<AgUiEvent, never, R | RunStore | Crypto.Crypto>((queue) => {
    const emit = (event: AgUiEvent) => Effect.asVoid(Queue.offer(queue, event));
    const refuse = ({ message, code }: ResumeRejected | RunFailed) =>
      emit({ type: "RUN_ERROR", message, ...optionalProperty("code", code) });
    return RunStore.use((store) => store.pendingInterrupts(input.threadId)).pipe(
      Effect.mapError(asRunFailed),
      Effect.flatMap((pending) => resumeAnswers(pending, input.resume)),
      Effect.matchEffect({
        onFailure: refuse,
        onSuccess: (resumed) => runAccepted(spec, input, emit, resumed),
      }),
      Effect.ensuring(Queue.end(queue)),
    );
  });
}
