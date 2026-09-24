import { Schema } from "effect";

/**
 * A coding agent whose local transcripts can be migrated into this app's memory.
 * A new tool is one more tag here plus one adapter file next to this one.
 */
export const ImportSourceName = Schema.Literals(["claude-code", "codex"]);
export type ImportSourceName = typeof ImportSourceName.Type;

/** Which conversation a transcript holds and where it was held. */
export interface TranscriptStart {
  readonly kind: "session";
  /** The other tool's own conversation id. */
  readonly externalId: string;
  /** The working directory the conversation ran in; this is what picks the project. */
  readonly cwd: string;
  readonly startedAt: string;
}

/** Something a person or an assistant said, verbatim. */
export interface TranscriptMessage {
  readonly kind: "message";
  readonly role: "user" | "assistant";
  /** Unique within the source; the same line read twice must produce the same id. */
  readonly externalId: string;
  readonly at: string;
  readonly text: string;
}

export interface TranscriptToolCall {
  readonly kind: "tool_call";
  readonly externalId: string;
  readonly at: string;
  readonly toolName: string;
  readonly toolCallId: string;
  /** The text a `tool_call` node holds: the name followed by the arguments, as `record.ts` writes it. */
  readonly text: string;
  readonly refs: readonly string[];
}

export interface TranscriptToolResult {
  readonly kind: "tool_result";
  readonly externalId: string;
  readonly at: string;
  readonly toolCallId: string;
  readonly ok: boolean;
  readonly text: string;
}

/** A line that carries no memory: reasoning, telemetry, the other tool's own bookkeeping. */
export interface TranscriptNoise {
  readonly kind: "ignored";
}

export type TranscriptItem =
  | TranscriptStart
  | TranscriptMessage
  | TranscriptToolCall
  | TranscriptToolResult
  | TranscriptNoise;

/**
 * Reads one JSONL line of a transcript. A line can hold several items (an assistant turn with
 * text and two tool calls), and may repeat the `session` item on every line; the caller keeps the
 * first one. An unreadable or uninteresting line is simply no items.
 */
export type TranscriptReader = (line: string) => readonly TranscriptItem[];

/**
 * What a CLI writes into the user's side of a transcript: slash-command envelopes, project
 * instructions, interruption markers, a compaction summary. Attributing these to the person would
 * be wrong in a way that matters, because only user statements may correct or retract a decision.
 */
export interface InjectedText {
  /** An opening tag, with or without attributes: `<environment_context>`, `<command-name>`. */
  readonly tags: ReadonlySet<string>;
  /** Text the tool writes with no tag around it, matched from the start. */
  readonly prefixes: readonly string[];
}

export function isInjectedText(text: string, injected: InjectedText): boolean {
  const start = text.trimStart();
  const opening = /^<([a-z_-]+)[\s>/]/u.exec(start);
  if (opening !== null && injected.tags.has(opening[1] ?? "")) return true;
  return injected.prefixes.some((prefix) => start.startsWith(prefix));
}
