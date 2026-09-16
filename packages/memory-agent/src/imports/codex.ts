import { Option, Schema } from "effect";
import { refsInArguments } from "../memory/refs.ts";
import { isInjectedText, type InjectedText, type TranscriptReader } from "./items.ts";

/**
 * Codex CLI writes one rollout file per conversation under `~/.codex/sessions/<Y>/<M>/<D>`.
 * `session_meta` opens it; `response_item` lines carry the conversation. `reasoning`,
 * `event_msg` and `turn_context` lines are the model's or the CLI's own working state.
 */

/** What the CLI sends as a user message: its own context, project instructions, agent handoffs. */
const injected: InjectedText = {
  tags: new Set([
    "user_instructions",
    "environment_context",
    "turn_aborted",
    "recommended_plugins",
    "codex_internal_context",
  ]),
  prefixes: ["# AGENTS.md instructions", "The following is the Codex agent history"],
};

const ContentParts = Schema.Array(
  Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
);

const MessagePayload = Schema.Struct({
  type: Schema.Literal("message", "agent_message"),
  role: Schema.optional(Schema.String),
  content: ContentParts,
});
/** The standard tool protocol: JSON arguments, an id the output refers back to. */
const FunctionCallPayload = Schema.Struct({
  type: Schema.Literal("function_call"),
  name: Schema.String,
  arguments: Schema.String,
  call_id: Schema.String,
});
/** Code mode tools take a raw body (a patch, a script) instead of JSON arguments. */
const CustomCallPayload = Schema.Struct({
  type: Schema.Literal("custom_tool_call"),
  name: Schema.String,
  input: Schema.String,
  call_id: Schema.String,
});
const OutputPayload = Schema.Struct({
  type: Schema.Literal("function_call_output", "custom_tool_call_output"),
  call_id: Schema.String,
  output: Schema.Union(Schema.String, Schema.Unknown),
});
const decodePayload = Schema.decodeUnknownOption(
  Schema.Union(MessagePayload, FunctionCallPayload, CustomCallPayload, OutputPayload),
);

const SessionLine = Schema.Struct({
  type: Schema.Literal("session_meta"),
  timestamp: Schema.String,
  payload: Schema.Struct({ session_id: Schema.String, cwd: Schema.String }),
});
const ItemLine = Schema.Struct({
  type: Schema.Literal("response_item"),
  timestamp: Schema.String,
  ordinal: Schema.Number,
  payload: Schema.Unknown,
});
const decodeLine = Schema.decodeUnknownOption(
  Schema.parseJson(Schema.Union(SessionLine, ItemLine)),
);

const isText = Schema.is(Schema.String);

const partsText = (parts: readonly { readonly text?: string | undefined }[]) =>
  parts
    .map((part) => part.text ?? "")
    .join("")
    .trim();

/**
 * Reads the lines of one rollout. Rollout lines have no conversation id of their own, so the
 * transcript's id is passed in (it is in the file name) and the ordinal makes a line unique in it.
 * Resuming mid-file must not depend on having seen `session_meta`.
 */
export const codexReader =
  (transcriptId: string): TranscriptReader =>
  (line) => {
    const decoded = Option.getOrUndefined(decodeLine(line));
    if (!decoded) return [];

    switch (decoded.type) {
      case "session_meta":
        return [
          {
            kind: "session",
            externalId: decoded.payload.session_id,
            cwd: decoded.payload.cwd,
            startedAt: decoded.timestamp,
          },
        ];
      case "response_item": {
        const payload = Option.getOrUndefined(decodePayload(decoded.payload));
        if (!payload) return [];
        const at = decoded.timestamp;
        const externalId = `${transcriptId}:${decoded.ordinal}`;
        switch (payload.type) {
          case "message":
          case "agent_message": {
            // `agent_message` is one Codex agent talking to another; it answers like an assistant.
            const role =
              payload.type === "message" && payload.role === "user" ? "user" : "assistant";
            if (
              payload.type === "message" &&
              payload.role !== "user" &&
              payload.role !== "assistant"
            )
              return [];
            const text = partsText(payload.content);
            if (text.length === 0 || (role === "user" && isInjectedText(text, injected))) return [];
            return [{ kind: "message", role, externalId, at, text }];
          }
          case "function_call":
            return [
              {
                kind: "tool_call",
                externalId,
                at,
                toolName: payload.name,
                toolCallId: payload.call_id,
                text: `${payload.name} ${payload.arguments}`,
                refs: refsInArguments(payload.arguments),
              },
            ];
          case "custom_tool_call":
            return [
              {
                kind: "tool_call",
                externalId,
                at,
                toolName: payload.name,
                toolCallId: payload.call_id,
                text: `${payload.name} ${payload.input}`,
                refs: [],
              },
            ];
          case "function_call_output":
          case "custom_tool_call_output":
            return [
              {
                kind: "tool_result",
                externalId,
                at,
                toolCallId: payload.call_id,
                // A rollout records what the tool returned, not whether the CLI treated it as an error.
                ok: true,
                text: isText(payload.output) ? payload.output : JSON.stringify(payload.output),
              },
            ];
        }
      }
    }
  };
