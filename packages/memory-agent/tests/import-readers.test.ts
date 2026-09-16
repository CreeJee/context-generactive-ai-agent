import { describe, expect, test } from "vite-plus/test";
import type { Json } from "../src/codex/app-server.ts";
import { readClaudeCodeLine } from "../src/imports/claude-code.ts";
import { codexReader } from "../src/imports/codex.ts";
import type { TranscriptItem } from "../src/imports/items.ts";

/** A transcript line as the tools write it; the readers take it serialized, as it is on disk. */
type TranscriptLine = { readonly [key: string]: Json };

const claudeLine = (line: TranscriptLine) => readClaudeCodeLine(JSON.stringify(line));
const readCodex = codexReader("01a0-session");
const codexLine = (line: TranscriptLine) => readCodex(JSON.stringify(line));

const kinds = (items: readonly TranscriptItem[]) => items.map((item) => item.kind);
const only = (items: readonly TranscriptItem[], kind: TranscriptItem["kind"]) =>
  items.filter((item) => item.kind === kind);

describe("Claude Code transcripts", () => {
  const userLine = {
    type: "user",
    uuid: "u-1",
    timestamp: "2026-09-01T10:00:00.000Z",
    cwd: "/Users/someone/work/app",
    sessionId: "s-1",
    message: { role: "user", content: "회상 기준을 정하자" },
  };

  test("reads a statement with the conversation it belongs to", () => {
    const items = claudeLine(userLine);
    expect(kinds(items)).toEqual(["session", "message"]);
    expect(items[0]).toEqual({
      kind: "session",
      externalId: "s-1",
      cwd: "/Users/someone/work/app",
      startedAt: "2026-09-01T10:00:00.000Z",
    });
    expect(items[1]).toEqual({
      kind: "message",
      role: "user",
      externalId: "u-1",
      at: "2026-09-01T10:00:00.000Z",
      text: "회상 기준을 정하자",
    });
  });

  test("splits an assistant turn into its text and each tool call", () => {
    const items = claudeLine({
      type: "assistant",
      uuid: "a-1",
      timestamp: "2026-09-01T10:00:05.000Z",
      cwd: "/Users/someone/work/app",
      sessionId: "s-1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "…" },
          { type: "text", text: "파일을 보겠습니다" },
          { type: "tool_use", id: "call-1", name: "Read", input: { file_path: "/app/notes.md" } },
        ],
      },
    });
    expect(kinds(items)).toEqual(["session", "message", "tool_call"]);
    expect(only(items, "message")[0]).toMatchObject({
      role: "assistant",
      text: "파일을 보겠습니다",
      externalId: "a-1#1",
    });
    expect(only(items, "tool_call")[0]).toMatchObject({
      toolName: "Read",
      toolCallId: "call-1",
      text: 'Read {"file_path":"/app/notes.md"}',
      // The file a call names becomes a `touches` edge, so both spellings of the argument count.
      refs: ["/app/notes.md"],
    });
  });

  test("reads a tool result and whether the tool failed", () => {
    const items = claudeLine({
      type: "user",
      uuid: "u-2",
      timestamp: "2026-09-01T10:00:06.000Z",
      cwd: "/Users/someone/work/app",
      sessionId: "s-1",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call-1", content: "File not found", is_error: true },
        ],
      },
    });
    expect(only(items, "tool_result")[0]).toMatchObject({
      toolCallId: "call-1",
      ok: false,
      text: "File not found",
    });
  });

  test("joins the text parts of a tool result written as content parts", () => {
    const items = claudeLine({
      type: "user",
      uuid: "u-3",
      timestamp: "2026-09-01T10:00:07.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-2",
            content: [
              { type: "text", text: "첫 줄\n" },
              { type: "image", source: {} },
              { type: "text", text: "둘째 줄" },
            ],
          },
        ],
      },
    });
    expect(only(items, "tool_result")[0]).toMatchObject({ ok: true, text: "첫 줄\n둘째 줄" });
  });

  test("drops a subagent's own conversation and context written as the user", () => {
    expect(claudeLine({ ...userLine, isSidechain: true })).toEqual([]);
    expect(claudeLine({ ...userLine, isMeta: true })).toEqual([]);
  });

  test("drops what the CLI wrote on the user's side", () => {
    const injected = [
      "<command-name>/model</command-name>\n<command-message>model</command-message>",
      "<local-command-stdout>(no content)</local-command-stdout>",
      "[Request interrupted by user for tool use]",
      "This session is being continued from a previous conversation that ran out of context.",
    ];
    for (const text of injected)
      expect(kinds(claudeLine({ ...userLine, message: { role: "user", content: text } }))).toEqual([
        "session",
      ]);
  });

  test("strips system reminders from around a statement", () => {
    const items = claudeLine({
      ...userLine,
      message: {
        role: "user",
        content: [{ type: "text", text: "<system-reminder>지침…</system-reminder>\n진행해줘" }],
      },
    });
    expect(only(items, "message")[0]).toMatchObject({ text: "진행해줘" });
  });

  test("ignores the tool's own bookkeeping lines", () => {
    expect(claudeLine({ type: "cost-state", sessionId: "s-1", totalCostUSD: 1 })).toEqual([]);
    expect(claudeLine({ type: "system", subtype: "hook", uuid: "x", timestamp: "t" })).toEqual([]);
    expect(readClaudeCodeLine("not json")).toEqual([]);
  });
});

describe("Codex rollouts", () => {
  test("opens with the conversation the rollout holds", () => {
    const items = codexLine({
      timestamp: "2026-09-02T01:00:00.000Z",
      ordinal: 0,
      type: "session_meta",
      payload: { session_id: "01a0-session", cwd: "/Users/someone/work/api" },
    });
    expect(items).toEqual([
      {
        kind: "session",
        externalId: "01a0-session",
        cwd: "/Users/someone/work/api",
        startedAt: "2026-09-02T01:00:00.000Z",
      },
    ]);
  });

  test("numbers a line by its ordinal, so resuming mid-file keeps the same ids", () => {
    const items = codexLine({
      timestamp: "2026-09-02T01:00:02.000Z",
      ordinal: 7,
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "이어서" }] },
    });
    expect(items).toEqual([
      {
        kind: "message",
        role: "user",
        externalId: "01a0-session:7",
        at: "2026-09-02T01:00:02.000Z",
        text: "이어서",
      },
    ]);
  });

  test("reads both tool protocols and their output", () => {
    const call = codexLine({
      timestamp: "2026-09-02T01:00:03.000Z",
      ordinal: 8,
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: '{"cmd":"ls","workdir":"/Users/someone/work/api"}',
        call_id: "call_a",
      },
    });
    expect(call[0]).toMatchObject({
      kind: "tool_call",
      toolName: "exec_command",
      toolCallId: "call_a",
      text: 'exec_command {"cmd":"ls","workdir":"/Users/someone/work/api"}',
    });

    const patch = codexLine({
      timestamp: "2026-09-02T01:00:04.000Z",
      ordinal: 9,
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "apply_patch",
        input: "*** Begin Patch",
        call_id: "call_b",
        status: "completed",
      },
    });
    expect(patch[0]).toMatchObject({
      kind: "tool_call",
      toolName: "apply_patch",
      text: "apply_patch *** Begin Patch",
      refs: [],
    });

    const output = codexLine({
      timestamp: "2026-09-02T01:00:05.000Z",
      ordinal: 10,
      type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: "call_b", output: "Exit code: 0" },
    });
    expect(output[0]).toMatchObject({ kind: "tool_result", toolCallId: "call_b", ok: true });
  });

  test("keeps an agent handoff as an assistant statement", () => {
    const items = codexLine({
      timestamp: "2026-09-02T01:00:06.000Z",
      ordinal: 11,
      type: "response_item",
      payload: {
        type: "agent_message",
        author: "/root/review",
        content: [
          { type: "input_text", text: "검토 끝" },
          { type: "encrypted_content", encrypted_content: "…" },
        ],
      },
    });
    expect(items[0]).toMatchObject({ kind: "message", role: "assistant", text: "검토 끝" });
  });

  test("drops what the CLI sends as a user message", () => {
    const injected = [
      '<codex_internal_context source="goal">\nContinue…',
      "<environment_context>\n…",
      "# AGENTS.md instructions for /Users/someone/work/api",
      "The following is the Codex agent history whose request action you are answering.",
    ];
    for (const [index, text] of injected.entries())
      expect(
        codexLine({
          timestamp: "2026-09-02T01:00:07.000Z",
          ordinal: 20 + index,
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
        }),
      ).toEqual([]);
  });

  test("ignores reasoning and the CLI's own events", () => {
    expect(
      codexLine({
        timestamp: "t",
        ordinal: 30,
        type: "response_item",
        payload: { type: "reasoning", summary: [], content: [] },
      }),
    ).toEqual([]);
    expect(
      codexLine({ timestamp: "t", type: "event_msg", payload: { type: "token_count" } }),
    ).toEqual([]);
  });
});
