import { Option, Schema } from "effect";
import { refsInArguments } from "../memory/refs.ts";
import { isInjectedText, type InjectedText, type TranscriptItem } from "./items.ts";

/**
 * Claude Code writes one JSONL file per conversation under `~/.claude/projects/<encoded cwd>`.
 * Only `user` and `assistant` lines carry the conversation; the rest (`attachment`, `system`,
 * `file-history-*`, `cost-state`, `bridge-session`, …) is the tool's own bookkeeping.
 */

/** What the CLI writes on the user's side: slash commands, interruptions, a compaction summary. */
const injected: InjectedText = {
  tags: new Set(["command-name", "command-message", "command-args", "local-command-stdout"]),
  prefixes: [
    "[Request interrupted",
    "This session is being continued from a previous conversation",
  ],
};

const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const ToolUsePart = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
});
/** A tool result body: a plain string, or content parts of which only the text ones matter. */
const ResultBody = Schema.Union([
  Schema.String,
  Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
]);
type ResultBody = typeof ResultBody.Type;
const ToolResultPart = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: Schema.String,
  is_error: Schema.optional(Schema.Boolean),
  content: Schema.optional(ResultBody),
});
const decodePart = Schema.decodeUnknownOption(
  Schema.Union([TextPart, ToolUsePart, ToolResultPart]),
);

const Line = Schema.Struct({
  type: Schema.Literals(["user", "assistant"]),
  uuid: Schema.String,
  timestamp: Schema.String,
  cwd: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  /** A subagent's own conversation, interleaved into the same file. */
  isSidechain: Schema.optional(Schema.Boolean),
  /** Context the CLI wrote as if the user had said it. */
  isMeta: Schema.optional(Schema.Boolean),
  message: Schema.Struct({
    role: Schema.Literals(["user", "assistant"]),
    content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]),
  }),
});
const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Line));

const isText = Schema.is(Schema.String);

const bodyText = (body: ResultBody | undefined): string => {
  if (body === undefined) return "";
  return isText(body) ? body : body.map((part) => part.text ?? "").join("");
};

/** System reminders are instructions the harness adds around the message, not part of it. */
const stripReminders = (text: string) =>
  text.replaceAll(/<system-reminder>[\s\S]*?<\/system-reminder>/gu, "").trim();

/** Reads one line of a Claude Code transcript. */
export function readClaudeCodeLine(line: string): readonly TranscriptItem[] {
  const decoded = Option.getOrUndefined(decodeLine(line));
  if (!decoded || decoded.isSidechain === true || decoded.isMeta === true) return [];

  const items: TranscriptItem[] = [];
  if (decoded.cwd !== undefined && decoded.sessionId !== undefined)
    items.push({
      kind: "session",
      externalId: decoded.sessionId,
      cwd: decoded.cwd,
      startedAt: decoded.timestamp,
    });

  const content = decoded.message.content;
  const parts = isText(content) ? [{ type: "text", text: content }] : content;
  const at = decoded.timestamp;
  // A line holds several parts, so each one needs its own id within the line.
  const idOf = (index: number) => (parts.length > 1 ? `${decoded.uuid}#${index}` : decoded.uuid);

  parts.forEach((part, index) => {
    const decodedPart = Option.getOrUndefined(decodePart(part));
    if (!decodedPart) return;
    switch (decodedPart.type) {
      case "text": {
        const text = stripReminders(decodedPart.text);
        if (text.length === 0 || isInjectedText(text, injected)) return;
        items.push({
          kind: "message",
          role: decoded.message.role,
          externalId: idOf(index),
          at,
          text,
        });
        return;
      }
      case "tool_use": {
        const args = JSON.stringify(decodedPart.input ?? {});
        items.push({
          kind: "tool_call",
          externalId: idOf(index),
          at,
          toolName: decodedPart.name,
          toolCallId: decodedPart.id,
          text: `${decodedPart.name} ${args}`,
          refs: refsInArguments(args),
        });
        return;
      }
      case "tool_result":
        items.push({
          kind: "tool_result",
          externalId: idOf(index),
          at,
          toolCallId: decodedPart.tool_use_id,
          ok: decodedPart.is_error !== true,
          text: bodyText(decodedPart.content),
        });
    }
  });
  return items;
}
