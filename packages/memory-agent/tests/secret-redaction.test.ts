import { Cause, Effect, FileSystem, Path, Schema } from "effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { Database } from "../src/db/database.ts";
import { Importer } from "../src/imports/importer.ts";
import type { JsonValue } from "../src/json.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { testRuntime } from "./support/runtime.ts";
import { selectTestModel } from "./support/provider.ts";
import { withTestPlatform } from "./support/platform.ts";

const stringifyJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** Assembled at run time so no key-shaped text sits in the repository. */
const githubToken = `${"gh"}p_${"Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2"}`;

const decodeRefs = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ ref: Schema.String })));
const line = (entry: { readonly [key: string]: JsonValue }) => stringifyJson(entry);

const send = Effect.fn("secretRedaction.send")(function* (
  runtime: Awaited<ReturnType<typeof testRuntime>>["runtime"],
  sessionId: string,
  runId: string,
  content: string,
) {
  return yield* Effect.gen(function* () {
    const agent = yield* AgentChat;
    const body = yield* stringifyJson({
      threadId: sessionId,
      runId,
      messages: [{ id: runId, role: "user", content }],
      tools: [],
      context: [],
    });
    const response = yield* agent.handle(
      new Request("http://127.0.0.1/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }),
      sessionId,
    );
    return yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) => new Cause.UnknownError(cause),
    });
  }).pipe(Effect.provideContext(yield* runtime.contextEffect));
});

describe("secrets in a chat run", () => {
  it.live("a tool result is hidden before the model, the page or memory sees it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const context = yield* Effect.promise(() => testRuntime({ testProvider: {} }));
      const { runtime, project, session } = context;
      yield* selectTestModel().pipe(Effect.provideContext(yield* runtime.contextEffect));
      yield* fs.writeFileString(
        path.join(project.root, "deploy.txt"),
        `remote: origin\ntoken: ${githubToken}\n`,
      );
      // The fake model repeats the result it got; the stream itself is never filtered, so what it
      // repeats is what it was given.
      const stream = yield* send(
        runtime,
        session.id,
        "run-read",
        'call read_file {"path":"deploy.txt"}',
      );
      expect(stream).not.toContain(githubToken);
      expect(stream).toContain("[redacted:github]");
      const stored = yield* Effect.provideContext(
        Effect.map(Nodes, (nodes) =>
          nodes
            .session(session.id)
            .map((node) => node.text)
            .join("\n"),
        ),
        yield* runtime.contextEffect,
      );
      expect(stored).not.toContain(githubToken);
      expect(stored).toContain("[redacted:github]");
    }).pipe(withTestPlatform),
  );

  it.live("a key the user pastes is not kept in memory", () =>
    Effect.gen(function* () {
      const context = yield* Effect.promise(() => testRuntime({ testProvider: {} }));
      const { runtime, session } = context;
      yield* selectTestModel().pipe(Effect.provideContext(yield* runtime.contextEffect));
      yield* send(runtime, session.id, "run-paste", `이 토큰으로 배포해줘 ${githubToken}`);
      const user = yield* Effect.provideContext(
        Effect.map(Nodes, (nodes) => nodes.latestOfKind(session.id, "user")),
        yield* runtime.contextEffect,
      );
      expect(user?.text).toBe("이 토큰으로 배포해줘 [redacted:github]");
    }).pipe(withTestPlatform),
  );
});

describe("secrets in migrated transcripts", () => {
  it.live("another agent's shell output is kept without the key it printed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { runtime, project, home } = yield* Effect.promise(() => testRuntime());
      const directory = path.join(home, ".claude", "projects", "encoded");
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(
        path.join(directory, "cc-9.jsonl"),
        [
          yield* line({
            type: "user",
            uuid: "u-1",
            timestamp: "2026-05-01T09:00:00.000Z",
            cwd: project.root,
            sessionId: "cc-9",
            message: { role: "user", content: "환경 변수 보여줘" },
          }),
          yield* line({
            type: "assistant",
            uuid: "a-1",
            timestamp: "2026-05-01T09:00:01.000Z",
            cwd: project.root,
            sessionId: "cc-9",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "c-1",
                  name: "WebFetch",
                  input: { url: `https://api.example.com/?token=${githubToken}` },
                },
              ],
            },
          }),
          yield* line({
            type: "user",
            uuid: "u-2",
            timestamp: "2026-05-01T09:00:02.000Z",
            cwd: project.root,
            sessionId: "cc-9",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "c-1",
                  content: `HOME=/x\nGITHUB_TOKEN=${githubToken}`,
                },
              ],
            },
          }),
        ].join("\n") + "\n",
      );
      const stored = yield* Effect.provideContext(
        Effect.gen(function* () {
          yield* (yield* Importer).runOnce;
          const migrated = (yield* (yield* Sessions).list(project.id)).find(
            (session) => session.importedFrom === "claude-code",
          );
          const nodes = (yield* Nodes).session(migrated?.id ?? "");
          const { sqlite } = yield* Database;
          const refs = yield* decodeRefs(sqlite.prepare("SELECT ref FROM node_refs").all());
          return { text: nodes.map((node) => node.text).join("\n"), refs };
        }),
        yield* runtime.contextEffect,
      );
      expect(stored.text).not.toContain(githubToken);
      expect(stored.text).toContain("GITHUB_TOKEN=[redacted:github]");
      // The URL the call named is remembered as a reference, without its token.
      expect(stored.refs.map((row) => row.ref)).toEqual([
        "https://api.example.com/?token=[redacted:github]",
      ]);
    }).pipe(withTestPlatform),
  );
});
