import type {
  AfterToolCallInfo,
  ChatMiddleware,
  ErrorInfo,
  ToolPhaseCompleteInfo,
} from "@tanstack/ai";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { PermissionReviews } from "../permissions/reviews.ts";
import { SecretRedactor } from "../secrets/redactor.ts";
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

const isString = Schema.is(Schema.String);
const decodeJson = Schema.decodeUnknownOption(Schema.parseJson());
/** A thrown tool (`{ error }`) or a declined approval (`{ approved: false }` from the client). */
const isErrorResult = Schema.is(
  Schema.Union(
    Schema.Struct({ error: Schema.String }),
    Schema.Struct({ approved: Schema.Literal(false) }),
  ),
);

/** Tool results are stored as the text the model saw: strings as-is, everything else as JSON. */
function resultText(entry: ToolPhaseCompleteInfo["results"][number]): string {
  if (entry.result === undefined) return "";
  return isString(entry.result) ? entry.result : JSON.stringify(entry.result);
}

function failureText(info: AfterToolCallInfo | ErrorInfo): string {
  if (info.error instanceof Error) return info.error.message;
  return isString(info.error) ? info.error : JSON.stringify(info.error);
}

const make = Effect.gen(function* () {
  const nodes = yield* Nodes;
  const reviews = yield* PermissionReviews;
  const redactor = yield* SecretRedactor;

  /**
   * Memory never keeps a secret, whoever printed it. Tool results reach here already hidden; this
   * also covers what the model says and the arguments it calls tools with, which can echo a key the
   * user pasted, and error messages, which are not results.
   */
  const hide = (text: string) =>
    Effect.runPromise(Effect.map(redactor.redactText(text), (redaction) => redaction.text));

  /** The review behind a gated call's result, when the permission gate decided it. */
  const permissionOf = (sessionId: string, toolCallId: string) => {
    const review = reviews.latest(sessionId, toolCallId);
    return review
      ? { decision: review.decision, decidedBy: review.decidedBy, reason: review.reason }
      : undefined;
  };

  return {
    /**
     * Middleware that writes every assistant message, tool call and tool result of one run
     * as it happens, so evidence survives an abort or a crashed process.
     */
    forRun(binding: RunBinding): ChatMiddleware {
      const base = {
        projectId: binding.projectId,
        sessionId: binding.sessionId,
        runId: binding.runId,
      };
      const outcomes = new Map<string, ToolOutcome>();

      /** Who answered, when it was an external agent in a direct conversation. */
      const source: NodeDetail = binding.externalAgent
        ? { externalAgent: binding.externalAgent }
        : {};

      /** The text has been through `hide` already. */
      const appendAssistant = (text: string, partial?: { reason: string }) =>
        nodes.append({
          ...base,
          kind: "assistant",
          text,
          detail: partial ? { ...source, partial: true, reason: partial.reason } : source,
          links: [{ kind: "reply", nodeId: binding.userNodeId }],
        });

      return {
        name: "memory-agent/record",

        // Every hook first hides what it will write, then checks and appends with no await in
        // between, so two hooks never both decide a node is still missing.

        async onIteration(ctx) {
          // Results the client wrote itself (a declined approval) never pass a server tool phase.
          const written = ctx.messages.flatMap((message) => {
            if (message.role !== "tool" || !message.toolCallId) return [];
            const text = Array.isArray(message.content)
              ? message.content
                  .flatMap((part) => (part.type === "text" ? [part.content] : []))
                  .join("")
              : (message.content ?? "");
            return [{ toolCallId: message.toolCallId, text }];
          });
          const hidden = await Promise.all(written.map((entry) => hide(entry.text)));
          written.forEach(({ toolCallId, text }, index) => {
            const call = nodes.toolNode(binding.sessionId, "tool_call", toolCallId);
            if (!call || nodes.toolNode(binding.sessionId, "tool_result", toolCallId)) return;
            const parsed = Option.getOrUndefined(decodeJson(text));
            nodes.append({
              ...base,
              runId: call.runId ?? binding.runId,
              kind: "tool_result",
              text: hidden[index] ?? "",
              detail: {
                toolName: call.detail.toolName,
                toolCallId,
                ok: !isErrorResult(parsed),
                permission: permissionOf(binding.sessionId, toolCallId),
              },
              links: [{ kind: "returns", nodeId: call.id }],
            });
          });
        },

        onAfterToolCall(_ctx, info) {
          const outcome: ToolOutcome = { ok: info.ok };
          if (!info.ok) outcome.error = failureText(info);
          outcomes.set(info.toolCallId, outcome);
        },

        async onToolPhaseComplete(ctx, info) {
          // A declined approval fires no after-call hook, and a call skipped by middleware reports
          // ok; the result itself says whether the tool really ran.
          const calls = info.toolCalls.map((call) => {
            const result = info.results.find((entry) => entry.toolCallId === call.id);
            if (!result) return { call, result, ok: true, resultText: "" };
            const reported = outcomes.get(call.id);
            const ok = (reported?.ok ?? true) && !isErrorResult(result.result);
            // A failure is recorded as its error message when there is one.
            const text = ok ? resultText(result) : (reported?.error ?? resultText(result));
            return { call, result, ok, resultText: text };
          });
          outcomes.clear();
          const [assistantText, callTexts, callRefs, resultTexts] = await Promise.all([
            hide(ctx.accumulatedContent),
            Promise.all(
              calls.map(({ call }) => hide(`${call.function.name} ${call.function.arguments}`)),
            ),
            // A URL a call names can carry a token in its query.
            Promise.all(
              calls.map(({ call }) =>
                Promise.all(refsInArguments(call.function.arguments).map(hide)),
              ),
            ),
            Promise.all(calls.map((entry) => hide(entry.resultText))),
          ]);

          // A run resumed after an approval replays calls recorded by the interrupted run.
          const recorded = new Map(
            info.toolCalls.flatMap((call) => {
              const node = nodes.toolNode(binding.sessionId, "tool_call", call.id);
              return node ? [[call.id, node] as const] : [];
            }),
          );
          const needsAssistant =
            ctx.accumulatedContent.length > 0 || recorded.size < info.toolCalls.length;
          const assistant = needsAssistant ? appendAssistant(assistantText) : null;

          calls.forEach(({ call, result, ok }, index) => {
            const callNode =
              recorded.get(call.id) ??
              nodes.append({
                ...base,
                kind: "tool_call",
                text: callTexts[index] ?? "",
                detail: { toolName: call.function.name, toolCallId: call.id },
                links: assistant ? [{ kind: "calls", nodeId: assistant.id }] : [],
                refs: callRefs[index] ?? [],
              });
            if (!result) return; // awaiting approval or client execution
            if (nodes.toolNode(binding.sessionId, "tool_result", call.id)) return;
            nodes.append({
              ...base,
              // Keep the result in the run that made the call, so history shows them together.
              runId: callNode.runId ?? binding.runId,
              kind: "tool_result",
              text: resultTexts[index] ?? "",
              detail: {
                toolName: call.function.name,
                toolCallId: call.id,
                ok,
                permission: permissionOf(binding.sessionId, call.id),
              },
              links: [{ kind: "returns", nodeId: callNode.id }],
            });
          });
        },

        async onFinish(_ctx, info) {
          if (info.content.length > 0) appendAssistant(await hide(info.content));
        },

        async onAbort(ctx, info) {
          if (ctx.accumulatedContent.length > 0)
            appendAssistant(await hide(ctx.accumulatedContent), {
              reason: info.reason ?? "aborted",
            });
        },

        async onError(ctx, info) {
          if (ctx.accumulatedContent.length > 0)
            appendAssistant(await hide(ctx.accumulatedContent), {
              reason: await hide(failureText(info)),
            });
        },
      };
    },
  };
});

/** Turns a chat run into memory nodes. The caller appends the user turn before starting the run. */
export class Recorder extends Context.Tag("memory-agent/Recorder")<
  Recorder,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.effect(Recorder, make);
}
