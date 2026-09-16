import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import type { Json } from "../src/codex/app-server.ts";
import { Database } from "../src/db/database.ts";
import { Importer } from "../src/imports/importer.ts";
import { sessionMessages } from "../src/agent/history.ts";
import { Indexer } from "../src/memory/embedding/indexer.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { Projects } from "../src/projects/projects.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { testRuntime } from "./support/runtime.ts";

type TranscriptLine = { readonly [key: string]: Json };
const serialize = (lines: readonly TranscriptLine[]) =>
  `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;

/** A Claude Code conversation in one project folder, with one tool call and its result. */
function claudeLines(cwd: string): TranscriptLine[] {
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

function codexLines(cwd: string): TranscriptLine[] {
  return [
    {
      timestamp: "2026-04-02T02:00:00.000Z",
      ordinal: 0,
      type: "session_meta",
      payload: { session_id: "cx-1", cwd },
    },
    {
      timestamp: "2026-04-02T02:00:01.000Z",
      ordinal: 1,
      type: "response_item",
      payload: { type: "reasoning", summary: [] },
    },
    {
      timestamp: "2026-04-02T02:00:02.000Z",
      ordinal: 2,
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "이어서" }] },
    },
  ];
}

const claudePath = (home: string, name: string) => {
  const directory = join(home, ".claude", "projects", "encoded-cwd");
  mkdirSync(directory, { recursive: true });
  return join(directory, name);
};

const codexPath = (home: string) => {
  const directory = join(home, ".codex", "sessions", "2026", "04", "02");
  mkdirSync(directory, { recursive: true });
  return join(directory, "rollout-2026-04-02T02-00-00-cx-1.jsonl");
};

const NodeRow = Schema.Struct({
  kind: Schema.String,
  text: Schema.String,
  created_at: Schema.String,
  run_id: Schema.NullOr(Schema.String),
});
const decodeNodes = Schema.decodeUnknownSync(Schema.Array(NodeRow));
const decodeEdges = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ kind: Schema.String, from_kind: Schema.String })),
);
const decodeCount = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }));
const decodeIndexed = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ text: Schema.String })),
);

const nodeRows = (sqlite: Database["Type"]["sqlite"], sessionId: string) =>
  decodeNodes(
    sqlite
      .prepare("SELECT kind, text, created_at, run_id FROM nodes WHERE session_id = ? ORDER BY seq")
      .all(sessionId),
  );

describe("migrating other agents' transcripts", () => {
  test("writes a conversation with the times the other tool recorded", async () => {
    const { runtime, project, home } = await testRuntime();
    writeFileSync(claudePath(home, "cc-1.jsonl"), serialize(claudeLines(project.root)));

    const rows = await runtime.runPromise(
      Effect.gen(function* () {
        const written = yield* (yield* Importer).runOnce;
        expect(written).toBe(4);
        const { sqlite } = yield* Database;
        const sessions = yield* (yield* Sessions).list(project.id);
        const migrated = sessions.find((session) => session.importedFrom === "claude-code");
        expect(migrated).toBeDefined();
        expect(migrated?.createdAt).toBe("2026-03-01T09:00:00.000Z");
        expect(migrated?.title).toBe("회상 기준을 정하자");
        return nodeRows(sqlite, migrated!.id);
      }),
    );

    expect(rows.map((row) => row.kind)).toEqual(["user", "assistant", "tool_call", "tool_result"]);
    expect(rows.map((row) => row.created_at)).toEqual([
      "2026-03-01T09:00:00.000Z",
      "2026-03-01T09:00:10.000Z",
      "2026-03-01T09:00:10.000Z",
      "2026-03-01T09:00:12.000Z",
    ]);
    // Everything answering one user turn shares its run, which is how the transcript renders.
    expect(new Set(rows.map((row) => row.run_id)).size).toBe(1);
  });

  test("builds the evidence chain the live recorder builds", async () => {
    const { runtime, project, home } = await testRuntime();
    writeFileSync(claudePath(home, "cc-1.jsonl"), serialize(claudeLines(project.root)));

    const edges = await runtime.runPromise(
      Effect.gen(function* () {
        yield* (yield* Importer).runOnce;
        const { sqlite } = yield* Database;
        return decodeEdges(
          sqlite
            .prepare(`
              SELECT e.kind, n.kind AS from_kind FROM edges e JOIN nodes n ON n.id = e.from_id
              WHERE n.project_id = ? ORDER BY e.kind, n.seq`)
            .all(project.id),
        );
      }),
    );

    expect(edges).toContainEqual({ kind: "calls", from_kind: "assistant" });
    expect(edges).toContainEqual({ kind: "returns", from_kind: "tool_result" });
    expect(edges).toContainEqual({ kind: "reply", from_kind: "assistant" });
    expect(edges.filter((edge) => edge.kind === "next")).toHaveLength(3);
  });

  test("stands in an empty answer when the assistant only called a tool", async () => {
    const { runtime, project, home } = await testRuntime();
    writeFileSync(
      claudePath(home, "cc-2.jsonl"),
      serialize([
        {
          type: "user",
          uuid: "u-1",
          timestamp: "2026-03-02T09:00:00.000Z",
          cwd: project.root,
          sessionId: "cc-2",
          message: { role: "user", content: "노트 좀 봐줘" },
        },
        {
          type: "assistant",
          uuid: "a-1",
          timestamp: "2026-03-02T09:00:01.000Z",
          cwd: project.root,
          sessionId: "cc-2",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "call-1", name: "Read", input: { file_path: "a.md" } },
            ],
          },
        },
      ]),
    );

    const { kinds, calls, jobs } = await runtime.runPromise(
      Effect.gen(function* () {
        yield* (yield* Importer).runOnce;
        const { sqlite } = yield* Database;
        const sessions = yield* (yield* Sessions).list(project.id);
        const migrated = sessions.find((session) => session.importedFrom === "claude-code")!;
        return {
          kinds: nodeRows(sqlite, migrated.id).map((row) => row.kind),
          calls: decodeCount(
            sqlite.prepare("SELECT count(*) AS count FROM edges WHERE kind = 'calls'").get(),
          ).count,
          // The stand-in says nothing, so it is not a statement to interpret.
          jobs: decodeCount(sqlite.prepare("SELECT count(*) AS count FROM interpret_jobs").get())
            .count,
        };
      }),
    );

    expect(kinds).toEqual(["user", "assistant", "tool_call"]);
    expect(calls).toBe(1);
    expect(jobs).toBe(1);
  });

  test("reading a transcript again adds nothing, and new lines are picked up", async () => {
    const { runtime, project, home } = await testRuntime();
    const path = claudePath(home, "cc-1.jsonl");
    writeFileSync(path, serialize(claudeLines(project.root)));
    const importer = await runtime.runPromise(Importer);

    expect(await runtime.runPromise(importer.runOnce)).toBe(4);
    expect(await runtime.runPromise(importer.runOnce)).toBe(0);

    appendFileSync(
      path,
      serialize([
        {
          type: "user",
          uuid: "u-3",
          timestamp: "2026-03-01T09:05:00.000Z",
          cwd: project.root,
          sessionId: "cc-1",
          message: { role: "user", content: "좋아 그대로 가자" },
        },
      ]),
    );
    expect(await runtime.runPromise(importer.runOnce)).toBe(1);

    const texts = await runtime.runPromise(
      Effect.gen(function* () {
        const { sqlite } = yield* Database;
        const sessions = yield* (yield* Sessions).list(project.id);
        const migrated = sessions.find((session) => session.importedFrom === "claude-code")!;
        return nodeRows(sqlite, migrated.id).map((row) => row.text);
      }),
    );
    expect(texts.at(-1)).toBe("좋아 그대로 가자");
  });

  test("leaves a half-written last line for the next pass", async () => {
    const { runtime, project, home } = await testRuntime();
    const path = claudePath(home, "cc-1.jsonl");
    const complete = serialize(claudeLines(project.root));
    const half = JSON.stringify({
      type: "user",
      uuid: "u-4",
      timestamp: "2026-03-01T09:06:00.000Z",
      cwd: project.root,
      sessionId: "cc-1",
      message: { role: "user", content: "아직 쓰는 중" },
    });
    writeFileSync(path, complete + half.slice(0, half.length - 10));
    const importer = await runtime.runPromise(Importer);
    expect(await runtime.runPromise(importer.runOnce)).toBe(4);

    writeFileSync(path, `${complete + half}\n`);
    expect(await runtime.runPromise(importer.runOnce)).toBe(1);
  });

  test("registers the folder a conversation ran in as a project", async () => {
    const { runtime, home, base } = await testRuntime();
    const folder = join(base, "another-project");
    mkdirSync(folder);
    writeFileSync(claudePath(home, "cc-1.jsonl"), serialize(claudeLines(folder)));

    const registered = await runtime.runPromise(
      Effect.gen(function* () {
        expect(yield* (yield* Importer).runOnce).toBe(4);
        return yield* (yield* Projects).list;
      }),
    );
    const added = registered.find((project) => project.root === folder);
    expect(added).toBeDefined();
    expect(added?.name).toBe("another-project");
    // Registering is what the user asked for, but it never relaxes how tool calls are approved.
    expect(added?.permissionMode).toBe("ask");
  });

  test("names a folder it cannot register, with why", async () => {
    const { runtime, home } = await testRuntime();
    writeFileSync(claudePath(home, "cc-1.jsonl"), serialize(claudeLines("/gone/for/good")));

    const overview = await runtime.runPromise(
      Effect.gen(function* () {
        const importer = yield* Importer;
        expect(yield* importer.runOnce).toBe(0);
        return yield* importer.overview;
      }),
    );
    expect(overview.unplaced).toEqual([
      { cwd: "/gone/for/good", reason: "not_found", transcripts: 1 },
    ]);
  });

  // chmod cannot take read access away from root, nor on Windows.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports a transcript it cannot read, reads the others, and tries it again next time",
    async () => {
      const { runtime, project, home } = await testRuntime();
      const unreadable = claudePath(home, "cc-1.jsonl");
      writeFileSync(unreadable, serialize(claudeLines(project.root)));
      writeFileSync(codexPath(home), serialize(codexLines(project.root)));
      chmodSync(unreadable, 0o000);
      const importer = await runtime.runPromise(Importer);
      try {
        // The Claude Code transcript comes first; failing it must not stop the Codex one.
        expect(await runtime.runPromise(importer.runOnce)).toBe(1);
        const overview = await runtime.runPromise(importer.overview);
        expect(
          overview.sources.map(({ name, migrated, failed }) => [name, migrated, failed]),
        ).toEqual([
          ["claude-code", 0, 1],
          ["codex", 1, 0],
        ]);
        expect(overview.failures).toEqual([
          { source: "claude-code", path: unreadable, reason: expect.stringContaining("EACCES") },
        ]);
      } finally {
        chmodSync(unreadable, 0o600);
      }

      expect(await runtime.runPromise(importer.runOnce)).toBe(4);
      const overview = await runtime.runPromise(importer.overview);
      expect(overview.failures).toEqual([]);
      expect(overview.sources.map(({ migrated, failed }) => [migrated, failed])).toEqual([
        [1, 0],
        [1, 0],
      ]);
    },
  );

  test("a hidden project still owns its folder's transcripts", async () => {
    const { runtime, project, home } = await testRuntime();
    writeFileSync(claudePath(home, "cc-1.jsonl"), serialize(claudeLines(project.root)));

    const { visible, all } = await runtime.runPromise(
      Effect.gen(function* () {
        const projects = yield* Projects;
        yield* projects.setHidden(project.id, true);
        yield* (yield* Importer).runOnce;
        return { visible: yield* projects.list, all: yield* projects.listAll };
      }),
    );
    // Out of the sidebar, but the conversation went to it rather than registering a second one.
    expect(visible).toEqual([]);
    expect(all.filter((entry) => entry.root === project.root)).toHaveLength(1);
  });

  test("never reads this app's own storage", async () => {
    const { runtime, project, storage } = await testRuntime();
    const directory = join(storage, "codex", "sessions", "2026", "04", "02");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "rollout-2026-04-02T02-00-00-cx-1.jsonl"),
      serialize(codexLines(project.root)),
    );
    // The app's own codex home lives under the storage root; its conversations are already nodes.
    expect(await runtime.runPromise(Effect.flatMap(Importer, (importer) => importer.runOnce))).toBe(
      0,
    );
  });

  test("indexes what was said today before a migrated backlog", async () => {
    const { runtime, project, session, home } = await testRuntime();
    writeFileSync(claudePath(home, "cc-1.jsonl"), serialize(claudeLines(project.root)));

    const indexed = await runtime.runPromise(
      Effect.gen(function* () {
        // The transcript is from March; this is now. Its rows land last but it must index first.
        const today = (yield* Nodes).append({
          projectId: project.id,
          sessionId: session.id,
          kind: "user",
          text: "오늘 한 말",
        });
        yield* (yield* Importer).runOnce;
        yield* (yield* Indexer).indexUpTo(1);
        const { sqlite } = yield* Database;
        return decodeIndexed(
          sqlite
            .prepare(
              "SELECT n.text FROM node_vectors v JOIN nodes n ON n.seq = v.node_seq ORDER BY n.seq",
            )
            .all(),
        ).map((row) => ({ text: row.text, isToday: row.text === today.text }));
      }),
    );

    expect(indexed).toEqual([{ text: "오늘 한 말", isToday: true }]);
  });

  test("reads Codex rollouts too, and queues migrated statements for interpretation", async () => {
    const { runtime, project, home } = await testRuntime();
    writeFileSync(codexPath(home), serialize(codexLines(project.root)));

    const { pending, rendered } = await runtime.runPromise(
      Effect.gen(function* () {
        yield* (yield* Importer).runOnce;
        const { sqlite } = yield* Database;
        const sessions = yield* (yield* Sessions).list(project.id);
        const migrated = sessions.find((session) => session.importedFrom === "codex")!;
        expect(migrated.createdAt).toBe("2026-04-02T02:00:00.000Z");
        const nodes = yield* Nodes;
        return {
          pending: decodeCount(
            sqlite
              .prepare("SELECT count(*) AS count FROM interpret_jobs WHERE status = 'pending'")
              .get(),
          ).count,
          rendered: sessionMessages(nodes.session(migrated.id), () => []),
        };
      }),
    );

    expect(pending).toBe(1);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.role).toBe("user");
    expect(rendered[0]?.parts).toEqual([{ type: "text", content: "이어서" }]);
  });
});
