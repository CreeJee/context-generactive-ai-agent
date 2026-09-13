import type {
  AfterToolCallInfo,
  ChatMiddleware,
  ErrorInfo,
  ToolCall,
  ToolPhaseCompleteInfo,
} from "@tanstack/ai";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { Nodes } from "./nodes.ts";

export interface RunBinding {
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  /** The user turn this run answers. Assistant nodes get a `reply` edge to it. */
  readonly userNodeId: string;
}

/** Tool argument fields treated as references to a file or URL. */
const RefArguments = Schema.parseJson(
  Schema.Struct({
    path: Schema.optional(Schema.String),
    file: Schema.optional(Schema.String),
    filePath: Schema.optional(Schema.String),
    url: Schema.optional(Schema.String),
    uri: Schema.optional(Schema.String),
  }),
);
const decodeRefArguments = Schema.decodeUnknownOption(RefArguments);

function refsOf(call: ToolCall): string[] {
  return Option.match(decodeRefArguments(call.function.arguments), {
    onNone: () => [],
    onSome: (args) =>
      [args.path, args.file, args.filePath, args.url, args.uri].filter(
        (ref): ref is string => ref !== undefined && ref.length > 0,
      ),
  });
}

interface ToolOutcome {
  ok: boolean;
  error?: string;
}

const isString = Schema.is(Schema.String);

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

      const appendAssistant = (text: string, partial?: { reason: string }) =>
        nodes.append({
          ...base,
          kind: "assistant",
          text,
          detail: partial ? { partial: true, reason: partial.reason } : {},
          links: [{ kind: "reply", nodeId: binding.userNodeId }],
        });

      return {
        name: "memory-agent/record",

        onAfterToolCall(_ctx, info) {
          const outcome: ToolOutcome = { ok: info.ok };
          if (!info.ok) outcome.error = failureText(info);
          outcomes.set(info.toolCallId, outcome);
        },

        onToolPhaseComplete(ctx, info) {
          const assistant = appendAssistant(ctx.accumulatedContent);
          for (const call of info.toolCalls) {
            const callNode = nodes.append({
              ...base,
              kind: "tool_call",
              text: `${call.function.name} ${call.function.arguments}`,
              detail: { toolName: call.function.name, toolCallId: call.id },
              links: [{ kind: "calls", nodeId: assistant.id }],
              refs: refsOf(call),
            });
            const result = info.results.find((entry) => entry.toolCallId === call.id);
            if (!result) continue; // awaiting approval or client execution
            const outcome = outcomes.get(call.id) ?? { ok: true };
            nodes.append({
              ...base,
              kind: "tool_result",
              text: outcome.ok ? resultText(result) : (outcome.error ?? resultText(result)),
              detail: { toolName: call.function.name, toolCallId: call.id, ok: outcome.ok },
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
