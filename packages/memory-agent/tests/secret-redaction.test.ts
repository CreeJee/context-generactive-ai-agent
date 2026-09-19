import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { Database } from "../src/db/database.ts";
import { Importer } from "../src/imports/importer.ts";
import type { JsonValue } from "../src/json.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { testRuntime } from "./support/runtime.ts";

/** Assembled at run time so no key-shaped text sits in the repository. */
const githubToken = `${"gh"}p_${"Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2"}`;

const decodeRefs = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ ref: Schema.String })));
const line = (entry: { readonly [key: string]: JsonValue }) => JSON.stringify(entry);

const send = (
  runtime: Awaited<ReturnType<typeof testRuntime>>["runtime"],
  sessionId: string,
  runId: string,
  content: string,
) =>
  runtime.runPromise(
    Effect.flatMap(AgentChat, (agent) =>
      Effect.promise(async () => {
        const response = await Effect.runPromise(
          agent.handle(
            new Request("http://127.0.0.1/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                threadId: sessionId,
                runId,
                messages: [{ id: runId, role: "user", content }],
                tools: [],
                context: [],
              }),
            }),
            sessionId,
          ),
        );
        return response.text();
      }),
    ),
  );

describe("secrets in a chat run", () => {
  test("a tool result is hidden before the model, the page or memory sees it", async () => {
    const context = await testRuntime({ testProvider: {} });
    const { runtime, project, session } = context;
    await context.provider!.select(runtime);
    writeFileSync(join(project.root, "deploy.txt"), `remote: origin\ntoken: ${githubToken}\n`);

    // The fake model repeats the result it got; the stream itself is never filtered, so what it
    // repeats is what it was given.
    const stream = await send(
      runtime,
      session.id,
      "run-read",
      'call read_file {"path":"deploy.txt"}',
    );
    expect(stream).not.toContain(githubToken);
    expect(stream).toContain("[redacted:github]");

    const stored = await runtime.runPromise(
      Effect.map(Nodes, (nodes) =>
        nodes
          .session(session.id)
          .map((node) => node.text)
          .join("\n"),
      ),
    );
    expect(stored).not.toContain(githubToken);
    expect(stored).toContain("[redacted:github]");
  });

  test("a key the user pastes is not kept in memory", async () => {
    const context = await testRuntime({ testProvider: {} });
    const { runtime, session } = context;
    await context.provider!.select(runtime);
    await send(runtime, session.id, "run-paste", `이 토큰으로 배포해줘 ${githubToken}`);

    const user = await runtime.runPromise(
      Effect.map(Nodes, (nodes) => nodes.latestOfKind(session.id, "user")),
    );
    expect(user?.text).toBe("이 토큰으로 배포해줘 [redacted:github]");
  });
});

describe("secrets in migrated transcripts", () => {
  test("another agent's shell output is kept without the key it printed", async () => {
    const { runtime, project, home } = await testRuntime();
    const directory = join(home, ".claude", "projects", "encoded");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "cc-9.jsonl"),
      [
        line({
          type: "user",
          uuid: "u-1",
          timestamp: "2026-05-01T09:00:00.000Z",
          cwd: project.root,
          sessionId: "cc-9",
          message: { role: "user", content: "환경 변수 보여줘" },
        }),
        line({
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
        line({
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

    const stored = await runtime.runPromise(
      Effect.gen(function* () {
        yield* (yield* Importer).runOnce;
        const migrated = (yield* (yield* Sessions).list(project.id)).find(
          (session) => session.importedFrom === "claude-code",
        );
        const nodes = (yield* Nodes).session(migrated?.id ?? "");
        const { sqlite } = yield* Database;
        const refs = decodeRefs(sqlite.prepare("SELECT ref FROM node_refs").all());
        return { text: nodes.map((node) => node.text).join("\n"), refs };
      }),
    );
    expect(stored.text).not.toContain(githubToken);
    expect(stored.text).toContain("GITHUB_TOKEN=[redacted:github]");
    // The URL the call named is remembered as a reference, without its token.
    expect(stored.refs.map((row) => row.ref)).toEqual([
      "https://api.example.com/?token=[redacted:github]",
    ]);
  });
});
