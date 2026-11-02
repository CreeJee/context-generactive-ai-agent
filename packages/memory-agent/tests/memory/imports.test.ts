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
import { ImportActivity, Importer } from "../../src/imports/importer.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { Projects } from "../../src/projects/projects.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { type AgentServices, TestEnv, testAgent } from "../support/test-env.ts";
import { sqlAll, sqlGet } from "../support/sql.ts";
import {
  type TranscriptLine,
  claudeLines,
  claudePath,
  serialize,
  writeClaude,
  writeTranscript,
} from "../support/transcripts.ts";

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

/** A Codex rollout under `codexHome`. Codex knows a conversation by the id in its file name. */
const codexRollout = Effect.fnUntraced(function* (codexHome: string) {
  const { project } = yield* TestEnv;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(codexHome, "sessions", "2026", "04", "02");
  yield* fs.makeDirectory(directory, { recursive: true });
  return path.join(directory, `rollout-2026-04-02T02-00-00-${project.id}.jsonl`);
});

/**
 * The store knows a Claude Code transcript by its file name and each of its lines by `uuid`, across
 * every project. Cases that share an agent give both the test project's id.
 */
const ownLines = Effect.fnUntraced(function* (lines: readonly TranscriptLine[]) {
  const { project } = yield* TestEnv;
  return lines.map((line) =>
    Schema.is(Schema.String)(line.uuid) ? { ...line, uuid: `${project.id}/${line.uuid}` } : line,
  );
});
const ownClaudePath = Effect.flatMap(TestEnv, ({ project }) => claudePath(`${project.id}.jsonl`));

/** Writes `lines` as the test project's Claude Code transcript; returns its path. */
const writeOwnClaude = Effect.fnUntraced(function* (lines: readonly TranscriptLine[]) {
  return yield* writeTranscript(yield* ownClaudePath, yield* ownLines(lines));
});

const appendTranscript = Effect.fnUntraced(function* (
  path: string,
  lines: readonly TranscriptLine[],
) {
  yield* (yield* FileSystem.FileSystem).writeFileString(
    path,
    yield* serialize(yield* ownLines(lines)),
    { flag: "a" },
  );
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
  return yield* decodeNodes(
    yield* sqlAll(
      "SELECT kind, text, created_at, run_id FROM nodes WHERE session_id = ? ORDER BY seq",
      session.id,
    ),
  );
});

const count = Effect.fnUntraced(function* (sql: string, ...params: ReadonlyArray<string>) {
  return (yield* decodeCount(yield* sqlGet(sql, ...params))).count;
});

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
  const { project, base } = yield* TestEnv;
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
  const parent = (yield* Path.Path).join(base, "worktrees", "repo");
  const worktree = Effect.fnUntraced(function* (name: string) {
    const path = (yield* Path.Path).join(parent, name);
    yield* git(project.root, ["worktree", "add", "-q", "-b", name, path]);
    return path;
  });
  return { parent, worktree };
});

/** The test project as one case sees it: a project and folder of its own in the shared agent. */
const ownProject = Effect.gen(function* () {
  const env = yield* TestEnv;
  const fs = yield* FileSystem.FileSystem;
  const base = yield* fs.makeTempDirectory({ directory: env.base });
  const root = (yield* Path.Path).join(base, "project");
  yield* fs.makeDirectory(root);
  const project = yield* (yield* Projects).add(root);
  const session = yield* (yield* Sessions).create(project.id);
  return TestEnv.of({ ...env, base, project, session });
});

/**
 * Starting an agent and its import worker takes longer than any of these cases, so they share one.
 * Each runs in a project of its own and checks only what its own transcripts did.
 */
testAgent()("migrating other agents' transcripts", (it) => {
  const sharing = <E>(
    name: string,
    test: () => Effect.Effect<void, E, AgentServices | TestEnv | Scope.Scope>,
  ) => it.effect(name, () => Effect.provideServiceEffect(test(), TestEnv, ownProject));

  sharing(
    "writes a conversation with the recorded times and the live recorder's evidence chain",
    () =>
      Effect.gen(function* () {
        const { project } = yield* TestEnv;
        yield* writeOwnClaude(claudeLines(project.root));
        expect(yield* runOnce).toBe(4);
        const session = yield* migrated("claude-code");
        expect(session.createdAt).toBe("2026-03-01T09:00:00.000Z");
        expect(session.title).toBe("회상 기준을 정하자");
        const rows = yield* migratedNodes("claude-code");
        expect(rows.map((row) => row.kind)).toEqual([
          "user",
          "assistant",
          "tool_call",
          "tool_result",
        ]);
        expect(rows.map((row) => row.created_at)).toEqual([
          "2026-03-01T09:00:00.000Z",
          "2026-03-01T09:00:10.000Z",
          "2026-03-01T09:00:10.000Z",
          "2026-03-01T09:00:12.000Z",
        ]);
        // Everything answering one user turn shares its run, which is how the transcript renders.
        expect(EffectArray.dedupe(rows.map((row) => row.run_id)).length).toBe(1);
        const edges = yield* decodeEdges(
          yield* sqlAll(
            `
          SELECT e.kind, n.kind AS from_kind FROM edges e JOIN nodes n ON n.id = e.from_id
          WHERE n.project_id = ? ORDER BY e.kind, n.seq`,
            project.id,
          ),
        );
        expect(edges).toContainEqual({ kind: "calls", from_kind: "assistant" });
        expect(edges).toContainEqual({ kind: "returns", from_kind: "tool_call" });
        expect(edges).toContainEqual({ kind: "reply", from_kind: "assistant" });
        expect(edges.filter((edge) => edge.kind === "next")).toHaveLength(3);
      }),
  );

  sharing("stands in an empty answer when the assistant only called a tool", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      yield* writeOwnClaude([
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
      ]);
      yield* runOnce;
      expect((yield* migratedNodes("claude-code")).map((row) => row.kind)).toEqual([
        "user",
        "assistant",
        "tool_call",
      ]);
      expect(
        yield* count(
          `SELECT count(*) AS count FROM edges e JOIN nodes n ON n.id = e.from_id
            WHERE e.kind = 'calls' AND n.project_id = ?`,
          project.id,
        ),
      ).toBe(1);
      // The stand-in says nothing, so it is not a statement to interpret.
      expect(
        yield* count(
          `SELECT count(*) AS count FROM interpret_jobs j JOIN nodes n ON n.id = j.node_id
            WHERE n.project_id = ?`,
          project.id,
        ),
      ).toBe(1);
    }),
  );

  sharing("reading a transcript again adds nothing, and new lines are picked up", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      const path = yield* writeOwnClaude(claudeLines(project.root));
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

  sharing("a tool call read in a later pass belongs to the turn still open", () =>
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
      const path = yield* writeOwnClaude([
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
      const calledFrom = yield* decodeNodes(
        yield* sqlAll(
          `
          SELECT n.kind, n.text, n.created_at, n.run_id FROM edges e
          JOIN nodes n ON n.id = e.from_id WHERE e.kind = 'calls' AND n.project_id = ?`,
          project.id,
        ),
      );
      // Not the first turn's answer: an empty stand-in in the second turn made the call.
      expect(calledFrom.map((row) => [row.kind, row.text])).toEqual([["assistant", ""]]);
    }),
  );

  sharing("leaves a half-written last line for the next pass", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* ownClaudePath;
      const complete = yield* serialize(yield* ownLines(claudeLines(project.root)));
      const last = yield* serialize(
        yield* ownLines([
          {
            type: "user",
            uuid: "u-4",
            timestamp: "2026-03-01T09:06:00.000Z",
            cwd: project.root,
            sessionId: "cc-1",
            message: { role: "user", content: "아직 쓰는 중" },
          },
        ]),
      );
      yield* fs.writeFileString(path, complete + last.slice(0, last.length - 10));
      expect(yield* runOnce).toBe(4);
      yield* fs.writeFileString(path, complete + last);
      expect(yield* runOnce).toBe(1);
    }),
  );

  sharing("registers the folder a conversation ran in as a project", () =>
    Effect.gen(function* () {
      const { base } = yield* TestEnv;
      const folder = (yield* Path.Path).join(base, "another-project");
      yield* (yield* FileSystem.FileSystem).makeDirectory(folder);
      yield* writeOwnClaude(claudeLines(folder));
      expect(yield* runOnce).toBe(4);
      const added = (yield* (yield* Projects).list).find((project) => project.root === folder);
      expect(added).toBeDefined();
      expect(added?.name).toBe("another-project");
      // Registering is what the user asked for, but it never relaxes how tool calls are approved.
      expect(added?.permissionMode).toBe("ask");
    }),
  );

  sharing("names a folder it cannot register, with why", () =>
    Effect.gen(function* () {
      yield* writeOwnClaude(claudeLines("/gone/for/good"));
      const importer = yield* Importer;
      expect(yield* importer.runOnce).toBe(0);
      expect(
        (yield* importer.overview).unplaced.filter((entry) => entry.cwd === "/gone/for/good"),
      ).toEqual([{ cwd: "/gone/for/good", reason: "not_found", transcripts: 1 }]);
    }),
  );

  sharing("a hidden project still owns its folder's transcripts", () =>
    Effect.gen(function* () {
      const { project } = yield* TestEnv;
      yield* writeOwnClaude(claudeLines(project.root));
      const projects = yield* Projects;
      yield* projects.setHidden(project.id, true);
      yield* runOnce;
      // Out of the sidebar, but the conversation went to it rather than registering a second one.
      const inFolder = (entry: { readonly root: string }) => entry.root === project.root;
      expect((yield* projects.list).filter(inFolder)).toEqual([]);
      expect((yield* projects.listAll).filter(inFolder)).toHaveLength(1);
    }),
  );

  sharing("never reads this app's own storage", () =>
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

  sharing("reads Codex rollouts too, and queues migrated statements for interpretation", () =>
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
        yield* count(
          `SELECT count(*) AS count FROM interpret_jobs j JOIN nodes n ON n.id = j.node_id
            WHERE j.status = 'pending' AND n.project_id = ?`,
          project.id,
        ),
      ).toBe(1);
      const rendered = sessionMessages(yield* (yield* Nodes).session(session.id), () => []);
      expect(rendered).toHaveLength(1);
      expect(rendered[0]?.role).toBe("user");
      expect(rendered[0]?.content).toBe("이어서");
    }),
  );

  sharing(
    "follows a Codex rollout compressed into its archive into the same, archived session",
    () =>
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

  sharing(
    "places a worktree's conversation in its repository's project, even once every worktree is gone",
    () =>
      Effect.gen(function* () {
        const { project, home } = yield* TestEnv;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { parent, worktree } = yield* repositoryWithWorktrees;
        const live = yield* fs.realPath(yield* worktree("live"));
        yield* fs.makeDirectory(path.join(live, "apps"));
        yield* writeOwnClaude(claudeLines(path.join(live, "apps")));
        yield* runOnce;
        const fromLive = yield* migrated("claude-code");
        expect(fromLive.worktreePath).toBe(live);

        // The folder git showed the worktree in is kept, so it still names the repository later.
        yield* git(project.root, ["worktree", "remove", "--force", live]);
        const worktrees = yield* fs.realPath(parent);
        const gone = path.join(worktrees, "gone");
        yield* writeTranscript(yield* codexRollout(path.join(home, ".codex")), codexLines(gone));
        yield* runOnce;
        const fromGone = yield* migrated("codex");
        expect(fromGone.worktreePath).toBe(gone);
        const roots = (yield* (yield* Projects).listAll).map((entry) => entry.root);
        expect(roots.filter((root) => root.startsWith(worktrees))).toEqual([]);
      }),
  );

  sharing("does not claim a gone folder beside worktrees that share their folder with others", () =>
    Effect.gen(function* () {
      const { home } = yield* TestEnv;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { parent, worktree } = yield* repositoryWithWorktrees;
      yield* worktree("live");
      const shared = yield* fs.realPath(parent);
      yield* fs.makeDirectory(path.join(shared, "unrelated"));
      const gone = path.join(shared, "gone");
      yield* writeTranscript(yield* codexRollout(path.join(home, ".codex")), codexLines(gone));
      const importer = yield* Importer;
      expect(yield* importer.runOnce).toBe(0);
      expect((yield* importer.overview).unplaced.filter((entry) => entry.cwd === gone)).toEqual([
        { cwd: gone, reason: "not_found", transcripts: 1 },
      ]);
    }),
  );

  sharing("folds a project migration made for a worktree into its repository's project", () =>
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
        { worktreePath: null, branch: null },
      );
      // Nodes are immutable evidence, but folding moves them along with their session.
      yield* sqlAll(
        `INSERT INTO nodes (id, project_id, session_id, kind, text, created_at)
        VALUES ('folded-node', ?, ?, 'user', '접힐 대화', '2026-04-02T02:00:01.000Z')`,
        split.id,
        moved.id,
      );
      yield* runOnce;
      expect(yield* sqlGet("SELECT project_id, text FROM nodes WHERE id = 'folded-node'")).toEqual({
        project_id: project.id,
        text: "접힐 대화",
      });
      const folded = yield* sessions.get(moved.id);
      expect(folded.projectId).toBe(project.id);
      expect(folded.worktreePath).toBe(split.root);
      expect((yield* projects.get(split.id)).hiddenAt).not.toBeNull();
    }),
  );
});

/** These check counts over the whole home and store, so each owns its agent. */
testAgent()("migrating other agents' transcripts", (it) => {
  it.effect("a pass started from settings is answered at once and reports how it went", () =>
    Effect.gen(function* () {
      yield* writeClaude;
      const importer = yield* Importer;
      yield* importer.start;
      // Joining the running pass waits for it rather than starting a second one.
      const joined = yield* Effect.forkChild(importer.runOnce);
      yield* Effect.yieldNow;
      expect(ImportActivity.$is("running")((yield* importer.overview).activity)).toBe(true);
      expect(yield* Fiber.join(joined)).toBe(4);
      const finished = yield* importer.overview;
      expect(ImportActivity.$is("finished")(finished.activity)).toBe(true);
      expect(finished.activity).toMatchObject({
        checked: 1,
        total: 1,
        written: 4,
        failed: 0,
      });
      expect(finished.sources[0]).toMatchObject({ transcripts: 1, migrated: 1, nodes: 4 });
    }),
  );
});

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
