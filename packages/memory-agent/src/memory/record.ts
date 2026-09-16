import type {
  AfterToolCallInfo,
  ChatMiddleware,
  ErrorInfo,
  ToolPhaseCompleteInfo,
} from "@tanstack/ai";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { PermissionReviews } from "../permissions/reviews.ts";
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

        onIteration(ctx) {
          // Results the client wrote itself (a declined approval) never pass a server tool phase.
          for (const message of ctx.messages) {
            if (message.role !== "tool" || !message.toolCallId) continue;
            const call = nodes.toolNode(binding.sessionId, "tool_call", message.toolCallId);
            if (!call || nodes.toolNode(binding.sessionId, "tool_result", message.toolCallId))
              continue;
            const text = Array.isArray(message.content)
              ? message.content
                  .flatMap((part) => (part.type === "text" ? [part.content] : []))
                  .join("")
              : (message.content ?? "");
            const parsed = Option.getOrUndefined(decodeJson(text));
            nodes.append({
              ...base,
              runId: call.runId ?? binding.runId,
              kind: "tool_result",
              text,
              detail: {
                toolName: call.detail.toolName,
                toolCallId: message.toolCallId,
                ok: !isErrorResult(parsed),
                permission: permissionOf(binding.sessionId, message.toolCallId),
              },
              links: [{ kind: "returns", nodeId: call.id }],
            });
          }
        },

        onAfterToolCall(_ctx, info) {
          const outcome: ToolOutcome = { ok: info.ok };
          if (!info.ok) outcome.error = failureText(info);
          outcomes.set(info.toolCallId, outcome);
        },

        onToolPhaseComplete(ctx, info) {
          // A run resumed after an approval replays calls recorded by the interrupted run.
          const recorded = new Map(
            info.toolCalls.flatMap((call) => {
              const node = nodes.toolNode(binding.sessionId, "tool_call", call.id);
              return node ? [[call.id, node] as const] : [];
            }),
          );
          const needsAssistant =
            ctx.accumulatedContent.length > 0 || recorded.size < info.toolCalls.length;
          const assistant = needsAssistant ? appendAssistant(ctx.accumulatedContent) : null;

          for (const call of info.toolCalls) {
            const callNode =
              recorded.get(call.id) ??
              nodes.append({
                ...base,
                kind: "tool_call",
                text: `${call.function.name} ${call.function.arguments}`,
                detail: { toolName: call.function.name, toolCallId: call.id },
                links: assistant ? [{ kind: "calls", nodeId: assistant.id }] : [],
                refs: refsInArguments(call.function.arguments),
              });
            const result = info.results.find((entry) => entry.toolCallId === call.id);
            if (!result) continue; // awaiting approval or client execution
            if (nodes.toolNode(binding.sessionId, "tool_result", call.id)) continue;
            // A declined approval fires no after-call hook, and a call skipped by middleware reports
            // ok; the result itself says whether the tool really ran.
            const reported = outcomes.get(call.id);
            const outcome = {
              ok: (reported?.ok ?? true) && !isErrorResult(result.result),
              error: reported?.error,
            };
            nodes.append({
              ...base,
              // Keep the result in the run that made the call, so history shows them together.
              runId: callNode.runId ?? binding.runId,
              kind: "tool_result",
              text: outcome.ok ? resultText(result) : (outcome.error ?? resultText(result)),
              detail: {
                toolName: call.function.name,
                toolCallId: call.id,
                ok: outcome.ok,
                permission: permissionOf(binding.sessionId, call.id),
              },
              links: [{ kind: "returns", nodeId: callNode.id }],
            });
          }
          outcomes.clear();
        },

        onFinish(_ctx, info) {
          if (info.content.length > 0) appendAssistant(info.content);
        },

        onAbort(ctx, info) {
          if (ctx.accumulatedContent.length > 0)
            appendAssistant(ctx.accumulatedContent, { reason: info.reason ?? "aborted" });
        },

        onError(ctx, info) {
          if (ctx.accumulatedContent.length > 0)
            appendAssistant(ctx.accumulatedContent, { reason: failureText(info) });
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
