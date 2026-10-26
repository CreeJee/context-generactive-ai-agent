import { runNativeEffectWith } from "../runtime/native-effect.ts";
import { isTruthy } from "../truthy.ts";
import type {
  AfterToolCallInfo,
  ChatMiddleware,
  ErrorInfo,
  ToolCall,
  ToolPhaseCompleteInfo,
} from "@tanstack/ai";
import {
  Array as Arr,
  Context,
  Effect,
  HashMap,
  Layer,
  Match,
  MutableHashMap,
  Option,
  Predicate,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql";
import type { StoredMessage } from "../chat-store/schema.ts";
import type { JsonValue } from "../json.ts";
import { type AnsweredCall, asRunFailed, type RunHook, StepEnded } from "../loop/run.ts";
import { RunEnd } from "../loop/store.ts";
import { PermissionReviews } from "../permissions/reviews.ts";
import { SecretRedactor } from "../secrets/redactor.ts";
import { isDiscoveryCall } from "../tools/lazy.ts";
import { Nodes, type NodeDetail } from "./nodes.ts";
import { refsInArguments } from "./refs.ts";

export interface RunBinding {
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  /** The user turn this run answers. Assistant nodes get a `reply` edge to it. */
  readonly userNodeId: string;
  /** Set when an external ACP agent answers instead of the app's model. */
  readonly externalAgent?: string;
}

interface ToolOutcome {
  ok: boolean;
  error?: string;
}

type AssistantMessage = Extract<StoredMessage, { readonly role: "assistant" }>;

/** A call of a step as the model made it, with its result if it has one. */
interface RecordedCall {
  readonly id: string;
  readonly name: string;
  /** The arguments as the model wrote them. */
  readonly written: string;
  /** None while the call waits for the user. */
  readonly result: Option.Option<{ readonly ok: boolean; readonly text: string }>;
}

const isString = Schema.is(Schema.String);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
/**
 * A result that reports the work did not succeed: a thrown tool or a declined tool approval
 * (`{ error }`), a denied permission review (`{ approved: false }`), a shell command that did not
 * exit cleanly, or an external agent that did not finish. Goal completion only counts results
 * recorded as ok.
 */
const isErrorResult = Schema.is(
  Schema.Union([
    Schema.Struct({ error: Schema.String }),
    Schema.Struct({ approved: Schema.Literal(false) }),
    Schema.Struct({
      status: Schema.Literals(["failed", "timed_out", "cancelled"]),
      exitCode: Schema.NullOr(Schema.Finite),
      stdout: Schema.String,
    }),
    Schema.Struct({
      agent: Schema.String,
      status: Schema.Literals(["cancelled", "failed", "disconnected", "unavailable"]),
      note: Schema.String,
    }),
  ]),
);

/** Tool results are stored as the text the model saw: strings as-is, everything else as JSON. */
function resultText(entry: ToolPhaseCompleteInfo["results"][number]): string {
  if (entry.result === undefined) return "";
  return isString(entry.result) ? entry.result : JSON.stringify(entry.result);
}

/** {@link resultText} of an Effect AI loop result. */
const jsonText = (result: JsonValue) =>
  Predicate.isString(result) ? result : JSON.stringify(result);

function failureText(info: AfterToolCallInfo | ErrorInfo): string {
  if (info.error instanceof Error) return info.error.message;
  return isString(info.error) ? info.error : JSON.stringify(info.error);
}

/**
 * What a call's answer is recorded as. A tool that ran and failed is recorded as its error
 * message; a call answered without running, as the result the model read.
 */
const recordedResult = ({ answer }: AnsweredCall) =>
  Match.valueTags(answer, {
    Returned: ({ result }) => ({ ok: !isErrorResult(result), text: jsonText(result) }),
    Failed: ({ message }) => ({ ok: false, text: message }),
    Refused: ({ result }) => ({ ok: !isErrorResult(result), text: jsonText(result) }),
  });

/** The reason a cut answer is kept with: the run's failure, or its abort. */
const partialReason = RunEnd.$match({
  Completed: () => Option.none<string>(),
  Interrupted: () => Option.none<string>(),
  Failed: ({ message }) => Option.some(message),
  Aborted: () => Option.some("aborted"),
});

/** One run's recorder; every write goes through it, from either chat loop. */
const recorderFor = Effect.fnUntraced(function* (binding: RunBinding) {
  const sql = yield* SqlClient.SqlClient;
  const nodes = yield* Nodes;
  const reviews = yield* PermissionReviews;
  const redactor = yield* SecretRedactor;

  /**
   * Memory never keeps a secret, whoever printed it. Tool results reach here already hidden; this
   * also covers what the model says and the arguments it calls tools with, which can echo a key the
   * user pasted, and error messages, which are not results.
   */
  const hide = (text: string) =>
    Effect.map(redactor.redactText(text), (redaction) => redaction.text);

  /** The review behind a gated call's result, when the permission gate decided it. */
  // Read before a hook's check-and-append, which must not yield in between.
  const permissionOf = (toolCallId: string) =>
    Effect.map(reviews.latest(binding.sessionId, toolCallId), (review) =>
      isTruthy(review)
        ? { decision: review.decision, decidedBy: review.decidedBy, reason: review.reason }
        : undefined,
    );

  const base = {
    projectId: binding.projectId,
    sessionId: binding.sessionId,
    runId: binding.runId,
  };

  /** Who answered, when it was an external agent in a direct conversation. */
  const source: NodeDetail = isTruthy(binding.externalAgent)
    ? { externalAgent: binding.externalAgent }
    : {};

  /** The text has been through `hide` already. */
  const appendAssistant = (text: string, partial?: { reason: string }) =>
    nodes.append({
      ...base,
      kind: "assistant",
      text,
      detail: partial !== undefined ? { ...source, partial: true, reason: partial.reason } : source,
      links: [{ kind: "reply", nodeId: binding.userNodeId }],
    });

  /**
   * A step's tool calls with what the model said alongside them. Every write first hides what it
   * will write, then checks and appends in one transaction, so two writers never both decide a node
   * is still missing.
   */
  const recordStep = (text: string, calls: ReadonlyArray<RecordedCall>) =>
    Effect.gen(function* () {
      const permissions = yield* Effect.forEach(calls, ({ id }) => permissionOf(id));
      const [assistantText, callTexts, callRefs, resultTexts] = yield* Effect.all(
        [
          hide(text),
          Effect.forEach(calls, ({ name, written }) => hide(`${name} ${written}`), {
            concurrency: "unbounded",
          }),
          Effect.forEach(
            calls,
            ({ written }) =>
              Effect.forEach(refsInArguments(written), hide, { concurrency: "unbounded" }),
            { concurrency: "unbounded" },
          ),
          Effect.forEach(
            calls,
            ({ result }) =>
              hide(Option.match(result, { onNone: () => "", onSome: (recorded) => recorded.text })),
            { concurrency: "unbounded" },
          ),
        ],
        { concurrency: "unbounded" },
      );

      yield* Effect.gen(function* () {
        // A run resumed after an approval replays calls recorded by the interrupted run.
        const recorded = HashMap.fromIterable(
          (yield* Effect.forEach(calls, ({ id }) =>
            nodes.toolNode(binding.sessionId, "tool_call", id),
          )).flatMap((node, index) => (isTruthy(node) ? [[calls[index]!.id, node] as const] : [])),
        );
        const needsAssistant = text.length > 0 || HashMap.size(recorded) < calls.length;
        const assistant = needsAssistant ? yield* appendAssistant(assistantText) : null;

        yield* Effect.forEach(
          calls,
          ({ id, name, result }, index) =>
            Effect.gen(function* () {
              const callNode = yield* Option.match(HashMap.get(recorded, id), {
                onSome: Effect.succeed,
                onNone: () =>
                  nodes.append({
                    ...base,
                    kind: "tool_call",
                    text: callTexts[index] ?? "",
                    detail: { toolName: name, toolCallId: id },
                    links: isTruthy(assistant) ? [{ kind: "calls", nodeId: assistant.id }] : [],
                    refs: callRefs[index] ?? [],
                  }),
              });
              // Awaiting approval, or recorded already.
              if (
                Option.isNone(result) ||
                isTruthy(yield* nodes.toolNode(binding.sessionId, "tool_result", id))
              )
                return;
              yield* nodes.append({
                ...base,
                // Keep the result in the run that made the call, so history shows them together.
                runId: callNode.runId ?? binding.runId,
                kind: "tool_result",
                text: resultTexts[index] ?? "",
                detail: {
                  toolName: name,
                  toolCallId: id,
                  ok: result.value.ok,
                  permission: permissions[index],
                },
                links: [{ kind: "returns", nodeId: callNode.id }],
              });
            }),
          { discard: true },
        );
      }).pipe(sql.withTransaction);
    });

  /** The run's final answer. */
  const recordAnswer = (text: string) =>
    Effect.asVoid(
      Effect.when(
        Effect.flatMap(hide(text), (hidden) => appendAssistant(hidden)),
        Effect.succeed(text.length > 0),
      ),
    );

  /** The answer a stopped run was writing, with why it stopped. */
  const recordPartial = <E>(text: string, reason: Effect.Effect<string, E>) =>
    Effect.asVoid(
      Effect.when(
        Effect.flatMap(Effect.all([hide(text), reason]), ([hidden, why]) =>
          appendAssistant(hidden, { reason: why }),
        ),
        Effect.succeed(text.length > 0),
      ),
    );

  return { hide, permissionOf, recordStep, recordAnswer, recordPartial };
});

const recordedCallOf = (call: Pick<ToolCall, "id" | "function">) => ({
  id: call.id,
  name: call.function.name,
  written: call.function.arguments,
});

/** Actual recording implementation; each invocation uses current central services and run state. */
export const makeRecordingMiddleware = Effect.fnUntraced(function* (
  binding: RunBinding,
): Effect.fn.Return<
  ChatMiddleware,
  never,
  Nodes | PermissionReviews | SecretRedactor | SqlClient.SqlClient
> {
  const run = runNativeEffectWith(
    yield* Effect.context<Nodes | PermissionReviews | SecretRedactor | SqlClient.SqlClient>(),
  );
  const sql = yield* SqlClient.SqlClient;
  const nodes = yield* Nodes;
  const recorder = yield* recorderFor(binding);
  const outcomes = MutableHashMap.empty<string, ToolOutcome>();

  return {
    name: "memory-agent/record",

    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    onIteration(ctx) {
      return run(
        Effect.gen(function* () {
          // Results the client wrote itself (a declined approval) never pass a server tool phase.
          const written = ctx.messages.flatMap((message) => {
            if (message.role !== "tool" || !isTruthy(message.toolCallId)) return [];
            const text = Array.isArray(message.content)
              ? message.content
                  .flatMap((part) => (part.type === "text" ? [part.content] : []))
                  .join("")
              : (message.content ?? "");
            return [{ toolCallId: message.toolCallId, text }];
          });
          const hidden = yield* Effect.forEach(written, (entry) => recorder.hide(entry.text), {
            concurrency: "unbounded",
          });
          const permissions = yield* Effect.forEach(written, ({ toolCallId }) =>
            recorder.permissionOf(toolCallId),
          );
          yield* Effect.forEach(written, ({ toolCallId, text }, index) =>
            Effect.gen(function* () {
              const call = yield* nodes.toolNode(binding.sessionId, "tool_call", toolCallId);
              if (
                !isTruthy(call) ||
                isTruthy(yield* nodes.toolNode(binding.sessionId, "tool_result", toolCallId))
              )
                return;
              const parsed = Option.getOrUndefined(decodeJson(text));
              yield* nodes.append({
                projectId: binding.projectId,
                sessionId: binding.sessionId,
                runId: call.runId ?? binding.runId,
                kind: "tool_result",
                text: hidden[index] ?? "",
                detail: {
                  toolName: call.detail.toolName,
                  toolCallId,
                  ok: !isErrorResult(parsed),
                  permission: permissions[index],
                },
                links: [{ kind: "returns", nodeId: call.id }],
              });
            }).pipe(sql.withTransaction),
          );
        }),
      );
    },

    onAfterToolCall(_ctx, info) {
      const outcome: ToolOutcome = { ok: info.ok };
      if (!info.ok) outcome.error = failureText(info);
      MutableHashMap.set(outcomes, info.toolCallId, outcome);
    },

    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    onToolPhaseComplete(ctx, info) {
      // Asking for a lazy tool's schema is not part of the work, so it is not remembered.
      const toolCalls = info.toolCalls.filter((call) => !isDiscoveryCall(call.function.name));
      // A declined approval fires no after-call hook, and a call skipped by middleware reports
      // ok; the result itself says whether the tool really ran.
      const calls = toolCalls.map((call): RecordedCall => {
        const result = info.results.find((entry) => entry.toolCallId === call.id);
        if (!isTruthy(result)) return { ...recordedCallOf(call), result: Option.none() };
        const reported = Option.getOrUndefined(MutableHashMap.get(outcomes, call.id));
        const ok = (reported?.ok ?? true) && !isErrorResult(result.result);
        // A failure is recorded as its error message when there is one.
        const text = ok ? resultText(result) : (reported?.error ?? resultText(result));
        return { ...recordedCallOf(call), result: Option.some({ ok, text }) };
      });
      MutableHashMap.clear(outcomes);
      return run(recorder.recordStep(ctx.accumulatedContent, calls));
    },

    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    onFinish(_ctx, info) {
      return run(recorder.recordAnswer(info.content));
    },

    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    onAbort(ctx, info) {
      return run(
        recorder.recordPartial(ctx.accumulatedContent, Effect.succeed(info.reason ?? "aborted")),
      );
    },

    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    onError(ctx, info) {
      return run(recorder.recordPartial(ctx.accumulatedContent, recorder.hide(failureText(info))));
    },
  };
});

/**
 * The same recording for the Effect AI loop. A step's calls are recorded when the step ends, with
 * the results of those that do not wait for the user; a resumed step adds the results of the calls
 * an earlier run recorded.
 */
export const makeRecordingHook = Effect.fnUntraced(function* (
  binding: RunBinding,
): Effect.fn.Return<
  RunHook,
  never,
  Nodes | PermissionReviews | SecretRedactor | SqlClient.SqlClient
> {
  const recorder = yield* recorderFor(binding);

  const stepCalls = (message: AssistantMessage, answered: ReadonlyArray<AnsweredCall>) =>
    // Asking for a lazy tool's schema is not part of the work, so it is not remembered.
    (message.toolCalls ?? [])
      .filter((call) => !isDiscoveryCall(call.function.name))
      .map((call): RecordedCall => ({
        ...recordedCallOf(call),
        result: Option.map(
          Arr.findFirst(answered, (entry) => entry.call.id === call.id),
          recordedResult,
        ),
      }));

  return {
    stepEnded: (_scope, step) =>
      StepEnded.$match(step, {
        Model: ({ message, answered }) =>
          Arr.isReadonlyArrayNonEmpty(message.toolCalls ?? [])
            ? recorder.recordStep(message.content ?? "", stepCalls(message, answered))
            : recorder.recordAnswer(message.content ?? ""),
        // The message was recorded with its calls when the earlier run wrote it.
        Resume: ({ message, answered }) => recorder.recordStep("", stepCalls(message, answered)),
      }).pipe(Effect.asVoid, Effect.mapError(asRunFailed)),

    ended: (_scope, end, saved) =>
      Option.match(
        Option.all({
          reason: partialReason(end),
          partial: Option.filter(
            Arr.last(saved),
            (message): message is AssistantMessage =>
              message.role === "assistant" && message.stopReason !== undefined,
          ),
        }),
        {
          onNone: () => Effect.void,
          onSome: ({ reason, partial }) =>
            Effect.asVoid(recorder.recordPartial(partial.content ?? "", recorder.hide(reason))),
        },
      ).pipe(Effect.ignore({ log: "Warn" })),
  };
});

const make = Effect.gen(function* () {
  const run = Effect.runSyncWith(
    yield* Effect.context<Nodes | PermissionReviews | SecretRedactor | SqlClient.SqlClient>(),
  );
  return {
    /** Implementation-only seam; provide the current central Context for each invocation. */
    factory: makeRecordingMiddleware,
    /** Synchronous SDK compatibility boundary, not a Goal's implementation-only authority. */
    forRun(binding: RunBinding): ChatMiddleware {
      return run(makeRecordingMiddleware(binding));
    },
    /** The recording of one Effect AI run. */
    hookForRun(binding: RunBinding): RunHook {
      return run(makeRecordingHook(binding));
    },
  };
});

/** Turns a chat run into memory nodes. The caller appends the user turn before starting the run. */
export class Recorder extends Context.Service<Recorder, Effect.Success<typeof make>>()(
  "memory-agent/memory/record/Recorder",
) {
  static readonly layer = Layer.effect(Recorder, make);
}
