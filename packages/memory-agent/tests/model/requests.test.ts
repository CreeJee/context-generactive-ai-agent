import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { describe, expect } from "vite-plus/test";
import { StoredMessage } from "../../src/chat-store/schema.ts";
import { fromPrompt, toPrompt } from "../../src/model/prompt.ts";
import { asTanStack, next, requestDifferences, system } from "../support/requests.ts";

/**
 * The Effect AI model sends what the TanStack adapter sent for every stored conversation, and its
 * prompt holds the stored messages without loss (docs/effect-ai-migration.md step 2). The golden
 * conversations give the shapes the app writes; the cases below give the ones replay rewrites.
 */

const Thread = Schema.Struct({ thread_id: Schema.String, messages: Schema.Array(StoredMessage) });
// Files of scenarios that end before a thread is written hold neither.
const Golden = Schema.fromJsonString(
  Schema.Struct({
    threads: Schema.optionalKey(Schema.Array(Thread)),
    history: Schema.optionalKey(Schema.Array(Thread)),
  }),
);
const decodeGolden = Schema.decodeUnknownEffect(Golden);

const goldenHistories = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(import.meta.dirname, "../golden/__golden__");
  const names = (yield* fs.readDirectory(directory)).filter((name) => name.endsWith(".json"));
  const files = yield* Effect.forEach(names.toSorted(), (name) =>
    Effect.map(
      Effect.flatMap(fs.readFileString(path.join(directory, name)), decodeGolden),
      (golden) => ({ name, golden }),
    ),
  );
  return files.flatMap(({ name, golden: { threads = [], history = [] } }) => [
    ...threads.map((thread) => ({ name: `${name} thread`, history: thread.messages })),
    // The screen history of a thread, group after group, is a longer history of the same shapes.
    ...[...new Set(history.map((group) => group.thread_id))].map((threadId) => ({
      name: `${name} history`,
      history: history
        .filter((group) => group.thread_id === threadId)
        .flatMap((group) => group.messages),
    })),
  ]);
}).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer]));

const call = (id: string, name: string, args: string) => ({
  id,
  type: "function" as const,
  function: { name, arguments: args },
});

/** Histories replay rewrites, which the golden conversations do not reach. */
const cases: ReadonlyArray<{ readonly name: string; readonly history: Array<StoredMessage> }> = [
  {
    name: "failed and cancelled turns",
    history: [
      { role: "user", content: "read it" },
      {
        role: "assistant",
        content: null,
        toolCalls: [call("failed-1", "read_file", '{"path":"a"}')],
        stopReason: "error",
      },
      { role: "tool", toolCallId: "failed-1", content: "late result" },
      { role: "assistant", content: "half an answer", stopReason: "aborted" },
      { role: "user", content: "again" },
    ],
  },
  {
    name: "calls left without a result",
    history: [
      { role: "user", content: "list and read" },
      {
        role: "assistant",
        toolCalls: [call("open-1", "list_files", "{}"), call("open-2", "read_file", "{}")],
      },
      { role: "tool", toolCallId: "open-1", content: "[]" },
      { role: "user", content: "never mind" },
    ],
  },
  {
    name: "arguments cut by the output limit",
    history: [
      { role: "user", content: "write" },
      {
        role: "assistant",
        content: "",
        finishReason: "length",
        toolCalls: [
          call("cut-1", "write_file", '{"path":"a","content":"unfini'),
          call("cut-2", "read_file", '{"path":"b"}'),
        ],
      },
      { role: "tool", toolCallId: "cut-1", content: "invalid", error: "invalid arguments" },
      { role: "tool", toolCallId: "cut-2", content: "b" },
    ],
  },
  {
    name: "lone surrogates",
    history: [
      { role: "user", content: "broken \uD800 text 😀" },
      {
        role: "assistant",
        content: "answer \uDC00",
        thinking: [{ content: "thought \uD800", signature: "signed" }],
        toolCalls: [call("text-1", "read_file", '{"path":"\uD800.txt"}')],
      },
      {
        role: "tool",
        toolCallId: "text-1",
        content: [{ type: "text", content: "tool \uDC00 text" }],
      },
    ],
  },
  {
    name: "images",
    history: [
      {
        role: "user",
        content: [
          { type: "text", content: "look" },
          { type: "image", source: { type: "url", value: "https://example.com/a.png" } },
          {
            type: "image",
            source: { type: "url", value: "data:image/png;base64,AAAA", mimeType: "image/png" },
          },
          { type: "image", source: { type: "data", value: "BBBB", mimeType: "image/jpeg" } },
        ],
      },
      { role: "assistant", toolCalls: [call("shot-1", "screenshot", "{}")] },
      {
        role: "tool",
        toolCallId: "shot-1",
        content: [
          { type: "text", content: "captured" },
          { type: "image", source: { type: "data", value: "CCCC", mimeType: "image/jpeg" } },
        ],
      },
    ],
  },
  {
    name: "segments of one turn",
    history: [
      { role: "user", content: "two steps" },
      { role: "assistant", id: "turn-1", toolCalls: [call("seg-1", "list_files", "{}")] },
      {
        role: "assistant",
        id: "turn-1-segment-1",
        content: "and also",
        toolCalls: [call("seg-2", "read_file", '{"path":"a"}')],
      },
      { role: "tool", toolCallId: "seg-1", content: "[]" },
      { role: "tool", toolCallId: "seg-2", content: "a" },
      { role: "assistant", id: "turn-1-segment-2", content: "done" },
    ],
  },
  {
    // The compatible request renames another model's ids; its own id takes the first new name.
    name: "calls from another model",
    history: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        source: { provider: "openai", api: "responses", model: "gpt-5.5" },
        thinking: [{ content: "plan", signature: "signed" }],
        toolCalls: [
          call("call_1|fc_1", "list_files", "{}"),
          call(`call_2|${"f".repeat(40)}`, "read_file", '{"path":"a"}'),
        ],
      },
      { role: "tool", toolCallId: "call_1|fc_1", content: "[]" },
      { role: "tool", toolCallId: `call_2|${"f".repeat(40)}`, content: "a" },
      {
        role: "assistant",
        source: { provider: "openai-compatible", api: "openai-completions", model: "local-model" },
        thinking: [{ content: "own thought" }],
        content: "own answer",
        toolCalls: [call("call_1_fc_1", "list_files", "{}")],
      },
      { role: "tool", toolCallId: "call_1_fc_1", content: "[]" },
    ],
  },
  {
    name: "content, thinking and results as stored",
    history: [
      { role: "user", id: "u-1", createdAt: "2026-10-26T00:00:00.000Z", content: "" },
      { role: "user", content: [] },
      {
        role: "assistant",
        id: "a-1",
        model: "claude-opus-5-5",
        source: { provider: "anthropic", api: "text", model: "claude-opus-5-5" },
        finishReason: "tool_calls",
        thinking: [
          { content: "", signature: "encrypted", redacted: true },
          { content: "visible", signature: "signed" },
        ],
        toolCalls: [call("r-1", "read_file", ""), call("r-2", "list_files", "{ }")],
      },
      { role: "tool", toolCallId: "r-1", content: "", error: "denied" },
      { role: "tool", id: "t-2", toolCallId: "r-2", content: '{"files":[]}' },
      {
        role: "assistant",
        model: "gpt-5.5",
        source: { provider: "openai", api: "text", model: "gpt-5.5" },
        finishReason: "stop",
        content: "",
        thinking: [
          {
            content: "summary",
            signature:
              "openai-reasoning:eyJpZCI6InJzLTEiLCJlbmNyeXB0ZWRDb250ZW50IjoiZW5jcnlwdGVkIn0",
          },
        ],
      },
      { role: "assistant", content: null, finishReason: null },
      { role: "assistant" },
    ],
  },
];

const allHistories = Effect.map(goldenHistories, (golden) => [...golden, ...cases]);

describe("Effect AI subscription and compatible models", () => {
  it.effect("keeps every stored message through the prompt", () =>
    Effect.gen(function* () {
      for (const { name, history } of yield* allHistories)
        expect(fromPrompt(toPrompt(history, [system])), name).toStrictEqual({
          system: [system],
          history,
        });
    }),
  );

  it.effect("sends the request the TanStack adapter sent", () =>
    Effect.gen(function* () {
      for (const { name, history } of yield* allHistories) {
        const continued = [...history, next];
        const differences = yield* requestDifferences({
          threadId: "thread-1",
          tanstack: continued.map(asTanStack),
          stored: continued,
        });
        expect(differences, name).toStrictEqual([
          { provider: "anthropic", difference: undefined },
          { provider: "openai", difference: undefined },
          { provider: "openai-compatible", difference: undefined },
        ]);
      }
    }),
  );
});
