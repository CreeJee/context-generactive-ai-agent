import { Effect, FileSystem, Path, Schema } from "effect";
import type { JsonValue } from "../../src/json.ts";
import { TestEnv } from "./test-env.ts";

export type TranscriptLine = { readonly [key: string]: JsonValue };
export const serialize = Effect.fn("imports.serialize")((lines: readonly TranscriptLine[]) =>
  Effect.forEach(lines, (line) =>
    Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(line),
  ).pipe(Effect.map((encoded) => `${encoded.join("\n")}\n`)),
);

/** A Claude Code conversation in one project folder, with one tool call and its result. */
export function claudeLines(cwd: string): TranscriptLine[] {
  return [
    { type: "cost-state", sessionId: "cc-1", totalCostUSD: 0.1 },
    {
      type: "user",
      uuid: "u-1",
      timestamp: "2026-03-01T09:00:00.000Z",
      cwd,
      sessionId: "cc-1",
      message: { role: "user", content: "회상 기준을 정하자" },
    },
    {
      type: "assistant",
      uuid: "a-1",
      timestamp: "2026-03-01T09:00:10.000Z",
      cwd,
      sessionId: "cc-1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "노트를 읽겠습니다" },
          { type: "tool_use", id: "call-1", name: "Read", input: { file_path: "notes.md" } },
        ],
      },
    },
    {
      type: "user",
      uuid: "u-2",
      timestamp: "2026-03-01T09:00:12.000Z",
      cwd,
      sessionId: "cc-1",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-1", content: "기준 초안" }],
      },
    },
  ];
}

export const claudePath = Effect.fnUntraced(function* (name = "cc-1.jsonl") {
  const { home } = yield* TestEnv;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(home, ".claude", "projects", "encoded-cwd");
  yield* fs.makeDirectory(directory, { recursive: true });
  return path.join(directory, name);
});

/** Write `lines` as a transcript the importer will find; returns its path. */
export const writeTranscript = Effect.fnUntraced(function* (
  path: string,
  lines: readonly TranscriptLine[],
) {
  yield* (yield* FileSystem.FileSystem).writeFileString(path, yield* serialize(lines));
  return path;
});

/** The standard Claude Code conversation, run in the test's project folder. */
export const writeClaude = Effect.gen(function* () {
  const { project } = yield* TestEnv;
  return yield* writeTranscript(yield* claudePath(), claudeLines(project.root));
});
