import { Cause, Effect, FileSystem, Path, Schema } from "effect";
import { expect } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { Importer } from "../../src/imports/importer.ts";
import type { JsonValue } from "../../src/json.ts";
import { embeddedKindFilter, Indexer } from "../../src/memory/embedding/indexer.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { SecretSweep } from "../../src/secrets/sweep.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { selectTestModel } from "../support/provider.ts";
import { TestEnv, freshSession, testAgent } from "../support/test-env.ts";
import { sqlAll, sqlGet, sqlRun } from "../support/sql.ts";

const stringifyJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const parseJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

/** Assembled at run time so no key-shaped text sits in the repository. */
const githubToken = `${"gh"}p_${"Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2"}`;

const decodeCount = Schema.decodeUnknownEffect(Schema.Struct({ count: Schema.Finite }));
const decodeValue = Schema.decodeUnknownEffect(Schema.Struct({ value: Schema.String }));
const decodeResultChunk = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ type: Schema.String, content: Schema.optional(Schema.String) }),
  ),
);
const decodeRefs = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ ref: Schema.String })));

/** One string column of the single row a query returns. */
const value = Effect.fnUntraced(function* (sql: string, ...values: Array<string | number>) {
  return (yield* decodeValue(yield* sqlGet(sql, ...values))).value;
});

/** Post one user message to AgentChat and read the run's whole event stream. */
const send = Effect.fnUntraced(function* (sessionId: string, runId: string, content: string) {
  const body = yield* stringifyJson({
    threadId: sessionId,
    runId,
    messages: [{ id: runId, role: "user", content }],
    tools: [],
    context: [],
  });
  const response = yield* (yield* AgentChat).handle(
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
});

const sessionText = (sessionId: string) =>
  Effect.flatMap(Nodes, (nodes) =>
    Effect.map(nodes.session(sessionId), (session) => session.map((node) => node.text).join("\n")),
  );

// Every query here is scoped to the test's session, so a sweep run by one test is harmless to
// the others.
testAgent({ testProvider: {} })("secrets on their way in", (it) => {
  it.effect("a tool result is hidden before the model, the page or memory sees it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { project } = yield* TestEnv;
      const session = yield* freshSession;
      yield* selectTestModel();
      yield* fs.writeFileString(
        path.join(project.root, "deploy.txt"),
        `remote: origin\ntoken: ${githubToken}\n`,
      );
      // The fake model repeats the result it got; the stream itself is never filtered, so what it
      // repeats is what it was given.
      const stream = yield* send(
        session,
        `${session}:read`,
        'call read_file {"path":"deploy.txt"}',
      );
      expect(stream).not.toContain(githubToken);
      expect(stream).toContain("[redacted:github]");
      const stored = yield* sessionText(session);
      expect(stored).not.toContain(githubToken);
      expect(stored).toContain("[redacted:github]");
    }),
  );

  it.effect("a failed tool gives the model its code, tag and redacted text", () =>
    Effect.gen(function* () {
      const session = yield* freshSession;
      yield* selectTestModel();
      const stream = yield* send(
        session,
        `${session}:missing`,
        `call read_file {"path":"missing/${githubToken}.txt"}`,
      );
      const results = yield* Effect.forEach(
        stream.split("\n").flatMap((line) => (line.startsWith("data: ") ? [line.slice(6)] : [])),
        (line) => decodeResultChunk(line),
      );
      const content = results.find((chunk) => chunk.type === "TOOL_CALL_RESULT")?.content;
      expect(yield* parseJson(content ?? "")).toEqual({
        error: "not_found",
        cause: expect.any(String),
        detail: "missing/[redacted:github].txt. Nothing exists at that path.",
      });
    }),
  );

  it.effect("a key the user pastes is not kept in memory", () =>
    Effect.gen(function* () {
      const session = yield* freshSession;
      yield* selectTestModel();
      yield* send(session, `${session}:paste`, `이 토큰으로 배포해줘 ${githubToken}`);
      expect((yield* (yield* Nodes).latestOfKind(session, "user"))?.text).toBe(
        "이 토큰으로 배포해줘 [redacted:github]",
      );
    }),
  );

  it.effect("another agent's shell output is migrated without the key it printed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { project, home } = yield* TestEnv;
      const directory = path.join(home, ".claude", "projects", "encoded");
      yield* fs.makeDirectory(directory, { recursive: true });
      const entry = (
        uuid: string,
        timestamp: string,
        message: { readonly [key: string]: JsonValue },
      ) =>
        stringifyJson({
          type: message.role,
          uuid,
          timestamp,
          cwd: project.root,
          sessionId: "cc-9",
          message,
        });
      const lines = [
        yield* entry("u-1", "2026-05-01T09:00:00.000Z", {
          role: "user",
          content: "환경 변수 보여줘",
        }),
        yield* entry("a-1", "2026-05-01T09:00:01.000Z", {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "c-1",
              name: "WebFetch",
              input: { url: `https://api.example.com/?token=${githubToken}` },
            },
          ],
        }),
        yield* entry("u-2", "2026-05-01T09:00:02.000Z", {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "c-1",
              content: `HOME=/x\nGITHUB_TOKEN=${githubToken}`,
            },
          ],
        }),
      ];
      yield* fs.writeFileString(path.join(directory, "cc-9.jsonl"), lines.join("\n") + "\n");
      yield* (yield* Importer).runOnce;
      const migrated = (yield* (yield* Sessions).list(project.id)).find(
        (session) => session.importedFrom === "claude-code",
      );
      const migratedId = migrated?.id ?? "";
      const text = yield* sessionText(migratedId);
      expect(text).not.toContain(githubToken);
      expect(text).toContain("GITHUB_TOKEN=[redacted:github]");
      // The URL the call named is remembered as a reference, without its token.
      const refs = yield* decodeRefs(
        yield* sqlAll(
          "SELECT ref FROM node_refs WHERE node_id IN (SELECT id FROM nodes WHERE session_id = ?)",
          migratedId,
        ),
      );
      expect(refs.map((row) => row.ref)).toEqual([
        "https://api.example.com/?token=[redacted:github]",
      ]);
    }),
  );

  it.effect(
    "the sweep hides the saved conversation, approvals, references and queued messages",
    () =>
      Effect.gen(function* () {
        const { project } = yield* TestEnv;
        const session = yield* freshSession;
        const queued = `${session}:queued`;
        const call = yield* (yield* Nodes).append({
          projectId: project.id,
          sessionId: session,
          kind: "tool_call",
          text: "fetch",
          refs: [`https://api.example.com/?token=${githubToken}`],
        });
        yield* sqlRun(
          "INSERT INTO chat_threads VALUES (?, ?, 0)",
          session,
          yield* stringifyJson([
            { role: "tool", content: `token: ${githubToken}`, toolCallId: "c-1" },
          ]),
        );
        yield* sqlRun(
          "INSERT INTO permission_reviews (session_id, tool_call_id, tool_name, input, decision, decided_by, reason, created_at) VALUES (?, 'c-2', 'run_shell', ?, 'ask', 'user', 'x', '2026')",
          session,
          yield* stringifyJson({ command: `GITHUB_TOKEN=${githubToken} gh pr list` }),
        );
        yield* sqlRun(
          "INSERT INTO queued_messages (id, session_id, seq, text, state, created_at, updated_at) VALUES (?, ?, 1, ?, 'held', 0, 0)",
          queued,
          session,
          `이걸로 해줘 ${githubToken}`,
        );

        const sweep = yield* SecretSweep;
        yield* sweep.run;
        // A second pass finds nothing more to hide.
        expect(yield* sweep.run).toBe(0);
        expect((yield* sweep.progress).every((entry) => entry.done)).toBe(true);
        expect(yield* value("SELECT ref AS value FROM node_refs WHERE node_id = ?", call.id)).toBe(
          "https://api.example.com/?token=[redacted:github]",
        );
        expect(
          yield* parseJson(
            yield* value("SELECT messages AS value FROM chat_threads WHERE thread_id = ?", session),
          ),
        ).toEqual([{ role: "tool", content: "token: [redacted:github]", toolCallId: "c-1" }]);
        expect(
          yield* parseJson(
            yield* value(
              "SELECT input AS value FROM permission_reviews WHERE session_id = ?",
              session,
            ),
          ),
        ).toEqual({ command: "GITHUB_TOKEN=[redacted:github] gh pr list" });
        expect(yield* value("SELECT text AS value FROM queued_messages WHERE id = ?", queued)).toBe(
          "이걸로 해줘 [redacted:github]",
        );
      }),
  );

  it.effect("the sweep catches what arrives after a finished pass, on the next one", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      const session = yield* freshSession;
      const sweep = yield* SecretSweep;
      // Nothing of this session to sweep yet: both passes reach the end and remember it.
      yield* sqlRun("INSERT INTO chat_threads VALUES (?, '[]', 0)", session);
      yield* sweep.run;

      // Text that skipped the way in: an older build wrote this node, and the conversation grew
      // inside its one row.
      yield* (yield* Nodes).append({
        projectId: project.id,
        sessionId: session,
        kind: "tool_result",
        text: `GITHUB_TOKEN=${githubToken}`,
      });
      yield* sqlRun(
        "UPDATE chat_threads SET messages = ? WHERE thread_id = ?",
        yield* stringifyJson([{ role: "user", content: githubToken }]),
        session,
      );

      expect(yield* sweep.run).toBe(1);
      expect(
        yield* value(
          "SELECT text AS value FROM nodes WHERE session_id = ? ORDER BY seq DESC LIMIT 1",
          session,
        ),
      ).toBe("GITHUB_TOKEN=[redacted:github]");
      expect(
        yield* parseJson(
          yield* value("SELECT messages AS value FROM chat_threads WHERE thread_id = ?", session),
        ),
      ).toEqual([{ role: "user", content: "[redacted:github]" }]);
    }),
  );
});

// The search indexes are counted across the whole database, so this sweep owns an agent.
testAgent()("SecretSweep of stored nodes", (it) => {
  it.effect(
    "hides secrets stored before redaction, in the text and in everything made from it",
    () =>
      Effect.gen(function* () {
        const { project, session } = yield* TestEnv;
        const nodes = yield* Nodes;
        const indexer = yield* Indexer;
        // Written the way it was before redaction existed: straight in. A statement, so it has a
        // vector to drop and make again.
        const leaked = yield* nodes.append({
          projectId: project.id,
          sessionId: session.id,
          kind: "user",
          text: `GITHUB_TOKEN=${githubToken}\ndeploy ok`,
        });
        const clean = yield* nodes.append({
          projectId: project.id,
          sessionId: session.id,
          kind: "assistant",
          text: "배포가 끝났어요",
        });
        yield* indexer.indexAll();
        yield* indexer.analyzeAll();

        const count = Effect.fnUntraced(function* (sql: string, ...values: Array<string | number>) {
          return (yield* decodeCount(yield* sqlGet(sql, ...values))).count;
        });
        const trigram = (query: string) =>
          count("SELECT count(*) AS count FROM nodes_fts WHERE nodes_fts MATCH ?", `"${query}"`);
        // The test analyser splits at `_` and lower-cases, so the token's body is one term.
        const termHits = count(
          "SELECT count(*) AS count FROM nodes_morph WHERE nodes_morph MATCH ?",
          `"${githubToken.slice(4).toLowerCase()}"`,
        );
        // Both indexes held the token before the sweep, so the checks below mean something.
        expect({
          tokenHits: yield* trigram(githubToken.slice(4, 20)),
          terms: yield* termHits,
        }).toEqual({ tokenHits: 1, terms: 1 });

        expect(yield* (yield* SecretSweep).run).toBe(1);
        const text = (id: string) => value("SELECT text AS value FROM nodes WHERE id = ?", id);
        expect(yield* text(leaked.id)).toBe("GITHUB_TOKEN=[redacted:github]\ndeploy ok");
        expect(yield* text(clean.id)).toBe("배포가 끝났어요");
        // The search index lost the old text and holds the new one.
        expect(yield* trigram(githubToken.slice(4, 20))).toBe(0);
        expect(yield* trigram("redacted:github")).toBe(1);
        expect(yield* termHits).toBe(0);
        // Re-embedding and re-analysis ran inside the sweep; nothing is left pending.
        expect(
          yield* count(
            `SELECT count(*) AS count FROM nodes n LEFT JOIN node_vectors v ON v.node_seq = n.seq WHERE v.node_seq IS NULL AND length(n.text) > 0 AND ${embeddedKindFilter}`,
          ),
        ).toBe(0);
      }),
  );

  it.effect("nodes stay immutable outside a sweep", () =>
    Effect.gen(function* () {
      const { project, session } = yield* TestEnv;
      const node = yield* (yield* Nodes).append({
        projectId: project.id,
        sessionId: session.id,
        kind: "user",
        text: "원문",
      });
      expect(
        String(
          (yield* Effect.flip(sqlRun("UPDATE nodes SET text = 'changed' WHERE seq = ?", node.seq)))
            .reason.cause,
        ),
      ).toContain("nodes are immutable evidence");
      // Even with a permit, only the text may change.
      yield* sqlRun("INSERT INTO secret_sweep_permits VALUES (?)", node.seq);
      expect(
        String(
          (yield* Effect.flip(
            sqlRun("UPDATE nodes SET kind = 'assistant' WHERE seq = ?", node.seq),
          )).reason.cause,
        ),
      ).toContain("nodes are immutable evidence");
      yield* sqlRun("DELETE FROM secret_sweep_permits WHERE node_seq = ?", node.seq);
    }),
  );
});
