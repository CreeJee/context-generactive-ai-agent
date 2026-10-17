import { zstdCompressSync } from "node:zlib";
import { NodeServices } from "@effect/platform-node";
import {
  Array as EffectArray,
  Context,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Schema,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";
import type { JsonValue } from "../../src/json.ts";
import { sessionMessages } from "../../src/agent/history.ts";
import { Database } from "../../src/db/database.ts";
import { Importer } from "../../src/imports/importer.ts";
import { Indexer } from "../../src/memory/embedding/indexer.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { Projects } from "../../src/projects/projects.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { type AgentServices, TestEnv, testAgent } from "../support/test-env.ts";

type TranscriptLine = { readonly [key: string]: JsonValue };
const serialize = Effect.fn("imports.serialize")((lines: readonly TranscriptLine[]) =>
  Effect.forEach(lines, (line) =>
    Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(line),
  ).pipe(Effect.map((encoded) => `${encoded.join("\n")}\n`)),
);

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

const claudePath = Effect.fnUntraced(function* (name = "cc-1.jsonl") {
  const { home } = yield* TestEnv;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(home, ".claude", "projects", "encoded-cwd");
  yield* fs.makeDirectory(directory, { recursive: true });
  return path.join(directory, name);
});

const codexRollout = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(home, "sessions", "2026", "04", "02");
    yield* fs.makeDirectory(directory, { recursive: true });
    return path.join(directory, "rollout-2026-04-02T02-00-00-cx-1.jsonl");
  });

/** Write `lines` as a transcript the importer will find; returns its path. */
const writeTranscript = Effect.fnUntraced(function* (
  path: string,
  lines: readonly TranscriptLine[],
) {
  yield* (yield* FileSystem.FileSystem).writeFileString(path, yield* serialize(lines));
  return path;
});

/** The standard Claude Code conversation, run in the test's project folder. */
const writeClaude = Effect.gen(function* () {
  const { project } = yield* TestEnv;
  return yield* writeTranscript(yield* claudePath(), claudeLines(project.root));
});

const appendTranscript = Effect.fnUntraced(function* (
  path: string,
  lines: readonly TranscriptLine[],
) {
  yield* (yield* FileSystem.FileSystem).writeFileString(path, yield* serialize(lines), {
    flag: "a",
  });
});

const runOnce = Effect.flatMap(Importer, (importer) => importer.runOnce);

const NodeRow = Schema.Struct({
  kind: Schema.String,
  text: Schema.String,
  created_at: Schema.String,
  run_id: Schema.NullOr(Schema.String),
});
const decodeNodes = Schema.decodeUnknownEffect(Schema.Array(NodeRow));
const decodeEdges = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ kind: Schema.String, from_kind: Schema.String })),
);
const decodeCount = Schema.decodeUnknownEffect(Schema.Struct({ count: Schema.Finite }));
const decodeIndexed = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ text: Schema.String })),
);

/** The project's session migrated from `source`. */
const migrated = Effect.fnUntraced(function* (source: "claude-code" | "codex") {
  const { project } = yield* TestEnv;
  const sessions = yield* (yield* Sessions).list(project.id);
  const session = sessions.find((entry) => entry.importedFrom === source);
  if (session === undefined) return expect.unreachable(`no ${source} session was migrated`);
  return session;
});

/** The migrated session's nodes in order. */
const migratedNodes = Effect.fnUntraced(function* (source: "claude-code" | "codex") {
  const session = yield* migrated(source);
  const { sqlite } = yield* Database;
  return yield* decodeNodes(
    sqlite
      .prepare("SELECT kind, text, created_at, run_id FROM nodes WHERE session_id = ? ORDER BY seq")
      .all(session.id),
  );
});

const count = Effect.fnUntraced(function* (sql: string) {
  const { sqlite } = yield* Database;
  return (yield* decodeCount(sqlite.prepare(sql).get())).count;
});

/** Importing reads the whole home and writes into the whole store, so each test owns its agent. */
const alone = <E>(
  name: string,
  test: () => Effect.Effect<void, E, AgentServices | TestEnv | Scope.Scope>,
) => testAgent()("migrating other agents' transcripts", (it) => it.effect(name, test));

alone("writes a conversation with the recorded times and the live recorder's evidence chain", () =>
  Effect.gen(function* () {
    const { project } = yield* TestEnv;
    yield* writeClaude;
    expect(yield* runOnce).toBe(4);
    const session = yield* migrated("claude-code");
    expect(session.createdAt).toBe("2026-03-01T09:00:00.000Z");
    expect(session.title).toBe("회상 기준을 정하자");
    const rows = yield* migratedNodes("claude-code");
    expect(rows.map((row) => row.kind)).toEqual(["user", "assistant", "tool_call", "tool_result"]);
    expect(rows.map((row) => row.created_at)).toEqual([
      "2026-03-01T09:00:00.000Z",
      "2026-03-01T09:00:10.000Z",
      "2026-03-01T09:00:10.000Z",
      "2026-03-01T09:00:12.000Z",
    ]);
    // Everything answering one user turn shares its run, which is how the transcript renders.
    expect(EffectArray.dedupe(rows.map((row) => row.run_id)).length).toBe(1);
    const { sqlite } = yield* Database;
    const edges = yield* decodeEdges(
      sqlite
        .prepare(`
          SELECT e.kind, n.kind AS from_kind FROM edges e JOIN nodes n ON n.id = e.from_id
          WHERE n.project_id = ? ORDER BY e.kind, n.seq`)
        .all(project.id),
    );
    expect(edges).toContainEqual({ kind: "calls", from_kind: "assistant" });
    expect(edges).toContainEqual({ kind: "returns", from_kind: "tool_call" });
    expect(edges).toContainEqual({ kind: "reply", from_kind: "assistant" });
    expect(edges.filter((edge) => edge.kind === "next")).toHaveLength(3);
  }),
);

alone("stands in an empty answer when the assistant only called a tool", () =>
  Effect.gen(function* () {
    const { project } = yield* TestEnv;
    yield* writeTranscript(yield* claudePath("cc-2.jsonl"), [
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
          content: [{ type: "tool_use", id: "call-1", name: "Read", input: { file_path: "a.md" } }],
        },
      },
    ]);
    yield* runOnce;
    expect((yield* migratedNodes("claude-code")).map((row) => row.kind)).toEqual([
      "user",
      "assistant",
      "tool_call",
    ]);
    expect(yield* count("SELECT count(*) AS count FROM edges WHERE kind = 'calls'")).toBe(1);
    // The stand-in says nothing, so it is not a statement to interpret.
    expect(yield* count("SELECT count(*) AS count FROM interpret_jobs")).toBe(1);
  }),
);

alone("reading a transcript again adds nothing, and new lines are picked up", () =>
  Effect.gen(function* () {
    const { project } = yield* TestEnv;
    const path = yield* writeClaude;
    expect(yield* runOnce).toBe(4);
    expect(yield* runOnce).toBe(0);
    yield* appendTranscript(path, [
      {
        type: "user",
        uuid: "u-3",
        timestamp: "2026-03-01T09:05:00.000Z",
        cwd: project.root,
        sessionId: "cc-1",
        message: { role: "user", content: "좋아 그대로 가자" },
      },
    ]);
    expect(yield* runOnce).toBe(1);
    expect((yield* migratedNodes("claude-code")).at(-1)?.text).toBe("좋아 그대로 가자");
  }),
);

alone("a tool call read in a later pass belongs to the turn still open", () =>
  Effect.gen(function* () {
    const { project } = yield* TestEnv;
    const line = (uuid: string, role: "user" | "assistant", content: JsonValue) => ({
      type: role,
      uuid,
      timestamp: "2026-03-01T09:10:00.000Z",
      cwd: project.root,
      sessionId: "cc-1",
      message: { role, content },
    });
    // The first turn is answered; the second turn's user message ends this pass.
    const path = yield* writeTranscript(yield* claudePath(), [
      line("u-1", "user", "첫 질문"),
      line("a-1", "assistant", "첫 답"),
      line("u-2", "user", "둘째 질문"),
    ]);
    expect(yield* runOnce).toBe(3);
    yield* appendTranscript(path, [
      line("a-2", "assistant", [
        { type: "tool_use", id: "call-2", name: "Read", input: { file_path: "b.md" } },
      ]),
    ]);
    expect(yield* runOnce).toBe(2);
    const { sqlite } = yield* Database;
    const calledFrom = yield* decodeNodes(
      sqlite
        .prepare(`
          SELECT n.kind, n.text, n.created_at, n.run_id FROM edges e
          JOIN nodes n ON n.id = e.from_id WHERE e.kind = 'calls'`)
        .all(),
    );
    // Not the first turn's answer: an empty stand-in in the second turn made the call.
    expect(calledFrom.map((row) => [row.kind, row.text])).toEqual([["assistant", ""]]);
  }),
);

alone("a pass started from settings is answered at once and reports how it went", () =>
  Effect.gen(function* () {
    yield* writeClaude;
    const importer = yield* Importer;
    yield* importer.start;
    // Joining the running pass waits for it rather than starting a second one.
    const joined = yield* Effect.forkChild(importer.runOnce);
    yield* Effect.yieldNow;
    expect((yield* importer.overview).activity?.status).toBe("running");
    expect(yield* Fiber.join(joined)).toBe(4);
    const finished = yield* importer.overview;
    expect(finished.activity).toMatchObject({
      status: "finished",
      checked: 1,
      total: 1,
      written: 4,
      failed: 0,
    });
    expect(finished.sources[0]).toMatchObject({ transcripts: 1, migrated: 1, nodes: 4 });
  }),
);

alone("leaves a half-written last line for the next pass", () =>
  Effect.gen(function* () {
    const { project } = yield* TestEnv;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* claudePath();
    const complete = yield* serialize(claudeLines(project.root));
    const half = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      type: "user",
      uuid: "u-4",
      timestamp: "2026-03-01T09:06:00.000Z",
      cwd: project.root,
      sessionId: "cc-1",
      message: { role: "user", content: "아직 쓰는 중" },
    });
    yield* fs.writeFileString(path, complete + half.slice(0, half.length - 10));
    expect(yield* runOnce).toBe(4);
    yield* fs.writeFileString(path, `${complete + half}\n`);
    expect(yield* runOnce).toBe(1);
  }),
);

alone("registers the folder a conversation ran in as a project", () =>
  Effect.gen(function* () {
    const { base } = yield* TestEnv;
    const folder = (yield* Path.Path).join(base, "another-project");
    yield* (yield* FileSystem.FileSystem).makeDirectory(folder);
    yield* writeTranscript(yield* claudePath(), claudeLines(folder));
    expect(yield* runOnce).toBe(4);
    const added = (yield* (yield* Projects).list).find((project) => project.root === folder);
    expect(added).toBeDefined();
    expect(added?.name).toBe("another-project");
    // Registering is what the user asked for, but it never relaxes how tool calls are approved.
    expect(added?.permissionMode).toBe("ask");
  }),
);

alone("names a folder it cannot register, with why", () =>
  Effect.gen(function* () {
    yield* writeTranscript(yield* claudePath(), claudeLines("/gone/for/good"));
    const importer = yield* Importer;
    expect(yield* importer.runOnce).toBe(0);
    expect((yield* importer.overview).unplaced).toEqual([
      { cwd: "/gone/for/good", reason: "not_found", transcripts: 1 },
    ]);
  }),
);

testAgent()("migrating other agents' transcripts", (it) => {
  // chmod cannot take read access away from root, nor on Windows.
  it.effect.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports a transcript it cannot read, reads the others, and tries it again next time",
    () =>
      Effect.gen(function* () {
        const { project, home } = yield* TestEnv;
        const fs = yield* FileSystem.FileSystem;
        const unreadable = yield* writeClaude;
        yield* writeTranscript(
          yield* codexRollout((yield* Path.Path).join(home, ".codex")),
          codexLines(project.root),
        );
        const permissionScope = yield* Scope.fork(yield* Scope.Scope, "sequential");
        yield* Effect.acquireRelease(fs.chmod(unreadable, 0o000), () =>
          fs.chmod(unreadable, 0o600).pipe(Effect.orDie),
        ).pipe(Scope.provide(permissionScope));
        const importer = yield* Importer;
        // The Claude Code transcript comes first; failing it must not stop the Codex one.
        expect(yield* importer.runOnce).toBe(1);
        const failing = yield* importer.overview;
        expect(
          failing.sources.map(({ name, migrated, failed }) => [name, migrated, failed]),
        ).toEqual([
          ["claude-code", 0, 1],
          ["codex", 1, 0],
        ]);
        expect(failing.failures).toEqual([
          {
            source: "claude-code",
            path: unreadable,
            reason: expect.stringContaining("PermissionDenied"),
          },
        ]);
        yield* Scope.close(permissionScope, Exit.void);
        expect(yield* importer.runOnce).toBe(4);
        const recovered = yield* importer.overview;
        expect(recovered.failures).toEqual([]);
        expect(recovered.sources.map(({ migrated, failed }) => [migrated, failed])).toEqual([
          [1, 0],
          [1, 0],
        ]);
      }),
  );
});

alone("a hidden project still owns its folder's transcripts", () =>
  Effect.gen(function* () {
    const { project } = yield* TestEnv;
    yield* writeClaude;
    const projects = yield* Projects;
    yield* projects.setHidden(project.id, true);
    yield* runOnce;
    // Out of the sidebar, but the conversation went to it rather than registering a second one.
    expect(yield* projects.list).toEqual([]);
    expect((yield* projects.listAll).filter((entry) => entry.root === project.root)).toHaveLength(
      1,
    );
  }),
);

alone("never reads this app's own storage", () =>
  Effect.gen(function* () {
    const { project, storage } = yield* TestEnv;
    // The app's own codex home lives under the storage root; its conversations are already nodes.
    yield* writeTranscript(
      yield* codexRollout((yield* Path.Path).join(storage, "codex")),
      codexLines(project.root),
    );
    expect(yield* runOnce).toBe(0);
  }),
);

alone("indexes what was said today before a migrated backlog", () =>
  Effect.gen(function* () {
    const { project, session } = yield* TestEnv;
    yield* writeClaude;
    // The transcript is from March; this is now. Its rows land last but it must index first.
    const today = (yield* Nodes).append({
      projectId: project.id,
      sessionId: session.id,
      kind: "user",
      text: "오늘 한 말",
    });
    yield* runOnce;
    yield* (yield* Indexer).indexUpTo(1);
    const { sqlite } = yield* Database;
    const indexed = yield* decodeIndexed(
      sqlite
        .prepare(
          "SELECT n.text FROM node_vectors v JOIN nodes n ON n.seq = v.node_seq ORDER BY n.seq",
        )
        .all(),
    );
    expect(indexed.map((row) => row.text)).toEqual([today.text]);
  }),
);

alone("reads Codex rollouts too, and queues migrated statements for interpretation", () =>
  Effect.gen(function* () {
    const { project, home } = yield* TestEnv;
    yield* writeTranscript(
      yield* codexRollout((yield* Path.Path).join(home, ".codex")),
      codexLines(project.root),
    );
    yield* runOnce;
    const session = yield* migrated("codex");
    expect(session.createdAt).toBe("2026-04-02T02:00:00.000Z");
    expect(
      yield* count("SELECT count(*) AS count FROM interpret_jobs WHERE status = 'pending'"),
    ).toBe(1);
    const rendered = sessionMessages((yield* Nodes).session(session.id), () => []);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.role).toBe("user");
    expect(rendered[0]?.parts).toEqual([{ type: "text", content: "이어서" }]);
  }),
);

alone("follows a Codex rollout compressed into its archive into the same, archived session", () =>
  Effect.gen(function* () {
    const { project, home } = yield* TestEnv;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const rollout = yield* writeTranscript(
      yield* codexRollout(path.join(home, ".codex")),
      codexLines(project.root),
    );
    yield* runOnce;
    const session = yield* migrated("codex");

    const archive = path.join(home, ".codex", "archived_sessions");
    yield* fs.makeDirectory(archive, { recursive: true });
    yield* fs.writeFile(
      path.join(archive, `${path.basename(rollout)}.zst`),
      zstdCompressSync(yield* fs.readFile(rollout)),
    );
    yield* fs.remove(rollout);
    expect(yield* runOnce).toBe(0);
    const sessions = yield* Sessions;
    const archived = yield* sessions.list(project.id, true);
    expect(archived.map((entry) => entry.id)).toEqual([session.id]);

    // Restoring it here holds: the archive is followed once, when that file is first read.
    yield* sessions.setArchived(session.id, false);
    yield* runOnce;
    expect((yield* sessions.get(session.id)).archivedAt).toBeNull();
  }),
);

const git = Effect.fnUntraced(function* (cwd: string, args: readonly string[]) {
  const platform = yield* Layer.build(NodeServices.layer);
  const spawner = Context.get(platform, ChildProcessSpawner.ChildProcessSpawner);
  const child = yield* spawner.spawn(ChildProcess.make("git", args, { cwd, stdin: "ignore" }));
  const [, , code] = yield* Effect.all(
    [Stream.runDrain(child.stdout), Stream.runDrain(child.stderr), child.exitCode],
    { concurrency: "unbounded" },
  );
  expect(code).toBe(0);
});

/** The test project as a repository with one commit, and a folder its worktrees are made in. */
const repositoryWithWorktrees = Effect.gen(function* () {
  const { project, home } = yield* TestEnv;
  yield* git(project.root, ["init", "-q"]);
  yield* git(project.root, [
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  ]);
  const parent = (yield* Path.Path).join(home, "worktrees", "repo");
  const worktree = Effect.fnUntraced(function* (name: string) {
    const path = (yield* Path.Path).join(parent, name);
    yield* git(project.root, ["worktree", "add", "-q", "-b", name, path]);
    return path;
  });
  return { parent, worktree };
});

alone(
  "places a worktree's conversation in its repository's project, even once the worktree is gone",
  () =>
    Effect.gen(function* () {
      const { project, home } = yield* TestEnv;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { parent, worktree } = yield* repositoryWithWorktrees;
      const live = yield* worktree("live");
      yield* fs.makeDirectory(path.join(live, "apps"));
      yield* writeTranscript(yield* claudePath(), claudeLines(path.join(live, "apps")));
      yield* writeTranscript(
        yield* codexRollout(path.join(home, ".codex")),
        codexLines(path.join(parent, "gone")),
      );
      yield* runOnce;
      const sessions = yield* (yield* Sessions).list(project.id);
      const imported = sessions.flatMap((session) => session.importedFrom ?? []);
      expect(imported.toSorted()).toEqual(["claude-code", "codex"]);
      const roots = (yield* (yield* Projects).listAll).map((entry) => entry.root);
      expect(roots.filter((root) => root.includes(`${path.sep}worktrees${path.sep}`))).toEqual([]);
    }),
);

alone("folds a project migration made for a worktree into its repository's project", () =>
  Effect.gen(function* () {
    const { project } = yield* TestEnv;
    const { worktree } = yield* repositoryWithWorktrees;
    const projects = yield* Projects;
    const split = yield* projects.add(yield* worktree("split"));
    const sessions = yield* Sessions;
    const moved = yield* sessions.createImported(
      split.id,
      null,
      "2026-04-02T02:00:00.000Z",
      "codex",
    );
    yield* runOnce;
    expect((yield* sessions.get(moved.id)).projectId).toBe(project.id);
    expect((yield* projects.get(split.id)).hiddenAt).not.toBeNull();
  }),
);
