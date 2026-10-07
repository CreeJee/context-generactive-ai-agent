import { it as effectTest } from "@effect/vitest";
import { Array as EffectArray } from "effect";

import { Effect, Exit, Fiber, FileSystem, Path, Schema, Scope } from "effect";
import { describe, expect } from "vite-plus/test";
import type { JsonValue } from "../src/json.ts";
import { Database } from "../src/db/database.ts";
import { Importer } from "../src/imports/importer.ts";
import { sessionMessages } from "../src/agent/history.ts";
import { Indexer } from "../src/memory/embedding/indexer.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { Projects } from "../src/projects/projects.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { withTestPlatform } from "./support/platform.ts";
import { testRuntime } from "./support/runtime.ts";

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

const claudePath = Effect.fnUntraced(function* (home: string, name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(home, ".claude", "projects", "encoded-cwd");
  yield* fs.makeDirectory(directory, { recursive: true });
  return path.join(directory, name);
});

const codexPath = Effect.fnUntraced(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(home, ".codex", "sessions", "2026", "04", "02");
  yield* fs.makeDirectory(directory, { recursive: true });
  return path.join(directory, "rollout-2026-04-02T02-00-00-cx-1.jsonl");
});

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

const nodeRows = Effect.fnUntraced(function* (
  sqlite: Database["Service"]["sqlite"],
  sessionId: string,
) {
  return yield* decodeNodes(
    sqlite
      .prepare("SELECT kind, text, created_at, run_id FROM nodes WHERE session_id = ? ORDER BY seq")
      .all(sessionId),
  );
});

describe("migrating other agents' transcripts", () => {
  effectTest.live("writes a conversation with the times the other tool recorded", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { runtime, project, home } = yield* Effect.promise(() => testRuntime());
      yield* fs.writeFileString(
        yield* claudePath(home, "cc-1.jsonl"),
        yield* serialize(claudeLines(project.root)),
      );
      const rows = yield* Effect.provideContext(
        Effect.gen(function* () {
          const written = yield* (yield* Importer).runOnce;
          expect(written).toBe(4);
          const { sqlite } = yield* Database;
          const sessions = yield* (yield* Sessions).list(project.id);
          const migrated = sessions.find((session) => session.importedFrom === "claude-code");
          expect(migrated).toBeDefined();
          expect(migrated?.createdAt).toBe("2026-03-01T09:00:00.000Z");
          expect(migrated?.title).toBe("회상 기준을 정하자");
          return yield* nodeRows(sqlite, migrated!.id);
        }),
        yield* runtime.contextEffect,
      );
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
    }).pipe(withTestPlatform),
  );

  effectTest.live("builds the evidence chain the live recorder builds", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { runtime, project, home } = yield* Effect.promise(() => testRuntime());
      yield* fs.writeFileString(
        yield* claudePath(home, "cc-1.jsonl"),
        yield* serialize(claudeLines(project.root)),
      );
      const edges = yield* Effect.provideContext(
        Effect.gen(function* () {
          yield* (yield* Importer).runOnce;
          const { sqlite } = yield* Database;
          return yield* decodeEdges(
            sqlite
              .prepare(`
              SELECT e.kind, n.kind AS from_kind FROM edges e JOIN nodes n ON n.id = e.from_id
              WHERE n.project_id = ? ORDER BY e.kind, n.seq`)
              .all(project.id),
          );
        }),
        yield* runtime.contextEffect,
      );
      expect(edges).toContainEqual({ kind: "calls", from_kind: "assistant" });
      expect(edges).toContainEqual({ kind: "returns", from_kind: "tool_call" });
      expect(edges).toContainEqual({ kind: "reply", from_kind: "assistant" });
      expect(edges.filter((edge) => edge.kind === "next")).toHaveLength(3);
    }).pipe(withTestPlatform),
  );

  effectTest.live("stands in an empty answer when the assistant only called a tool", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { runtime, project, home } = yield* Effect.promise(() => testRuntime());
      yield* fs.writeFileString(
        yield* claudePath(home, "cc-2.jsonl"),
        yield* serialize([
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
      const { kinds, calls, jobs } = yield* Effect.provideContext(
        Effect.gen(function* () {
          yield* (yield* Importer).runOnce;
          const { sqlite } = yield* Database;
          const sessions = yield* (yield* Sessions).list(project.id);
          const migrated = sessions.find((session) => session.importedFrom === "claude-code")!;
          return {
            kinds: (yield* nodeRows(sqlite, migrated.id)).map((row) => row.kind),
            calls: (yield* decodeCount(
              sqlite.prepare("SELECT count(*) AS count FROM edges WHERE kind = 'calls'").get(),
            )).count,
            // The stand-in says nothing, so it is not a statement to interpret.
            jobs: (yield* decodeCount(
              sqlite.prepare("SELECT count(*) AS count FROM interpret_jobs").get(),
            )).count,
          };
        }),
        yield* runtime.contextEffect,
      );
      expect(kinds).toEqual(["user", "assistant", "tool_call"]);
      expect(calls).toBe(1);
      expect(jobs).toBe(1);
    }).pipe(withTestPlatform),
  );

  effectTest.live("reading a transcript again adds nothing, and new lines are picked up", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { runtime, project, home } = yield* Effect.promise(() => testRuntime());
      const path = yield* claudePath(home, "cc-1.jsonl");
      yield* fs.writeFileString(path, yield* serialize(claudeLines(project.root)));
      const importer = yield* Effect.provideContext(Importer, yield* runtime.contextEffect);
      expect(yield* Effect.provideContext(importer.runOnce, yield* runtime.contextEffect)).toBe(4);
      expect(yield* Effect.provideContext(importer.runOnce, yield* runtime.contextEffect)).toBe(0);
      yield* fs.writeFileString(
        path,
        yield* serialize([
          {
            type: "user",
            uuid: "u-3",
            timestamp: "2026-03-01T09:05:00.000Z",
            cwd: project.root,
            sessionId: "cc-1",
            message: { role: "user", content: "좋아 그대로 가자" },
          },
        ]),
        { flag: "a" },
      );
      expect(yield* Effect.provideContext(importer.runOnce, yield* runtime.contextEffect)).toBe(1);
      const texts = yield* Effect.provideContext(
        Effect.gen(function* () {
          const { sqlite } = yield* Database;
          const sessions = yield* (yield* Sessions).list(project.id);
          const migrated = sessions.find((session) => session.importedFrom === "claude-code")!;
          return (yield* nodeRows(sqlite, migrated.id)).map((row) => row.text);
        }),
        yield* runtime.contextEffect,
      );
      expect(texts.at(-1)).toBe("좋아 그대로 가자");
    }).pipe(withTestPlatform),
  );

  effectTest.live("a tool call read in a later pass belongs to the turn still open", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { runtime, project, home } = yield* Effect.promise(() => testRuntime());
      const path = yield* claudePath(home, "cc-1.jsonl");
      const line = (uuid: string, role: "user" | "assistant", content: JsonValue) => ({
        type: role,
        uuid,
        timestamp: "2026-03-01T09:10:00.000Z",
        cwd: project.root,
        sessionId: "cc-1",
        message: { role, content },
      });
      // The first turn is answered; the second turn's user message ends this pass.
      yield* fs.writeFileString(
        path,
        yield* serialize([
          line("u-1", "user", "첫 질문"),
          line("a-1", "assistant", "첫 답"),
          line("u-2", "user", "둘째 질문"),
        ]),
      );
      const importer = yield* Effect.provideContext(Importer, yield* runtime.contextEffect);
      expect(yield* Effect.provideContext(importer.runOnce, yield* runtime.contextEffect)).toBe(3);
      yield* fs.writeFileString(
        path,
        yield* serialize([
          line("a-2", "assistant", [
            { type: "tool_use", id: "call-2", name: "Read", input: { file_path: "b.md" } },
          ]),
        ]),
        { flag: "a" },
      );
      const calledFrom = yield* Effect.provideContext(
        Effect.gen(function* () {
          expect(yield* importer.runOnce).toBe(2);
          const { sqlite } = yield* Database;
          return yield* decodeNodes(
            sqlite
              .prepare(`
              SELECT n.kind, n.text, n.created_at, n.run_id FROM edges e
              JOIN nodes n ON n.id = e.from_id WHERE e.kind = 'calls'`)
              .all(),
          );
        }),
        yield* runtime.contextEffect,
      );
      // Not the first turn's answer: an empty stand-in in the second turn made the call.
      expect(calledFrom.map((row) => [row.kind, row.text])).toEqual([["assistant", ""]]);
    }).pipe(withTestPlatform),
  );

  effectTest.live("a pass started from settings is answered at once and reports how it went", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { runtime, project, home } = yield* Effect.promise(() => testRuntime());
      yield* fs.writeFileString(
        yield* claudePath(home, "cc-1.jsonl"),
        yield* serialize(claudeLines(project.root)),
      );
      const importer = yield* Effect.provideContext(Importer, yield* runtime.contextEffect);
      const { status, written } = yield* Effect.provideContext(
        Effect.gen(function* () {
          yield* importer.start;
          // Joining the running pass waits for it rather than starting a second one.
          const joined = yield* Effect.forkChild(importer.runOnce);
          yield* Effect.yieldNow;
          const started = yield* importer.overview;
          return { status: started.activity?.status, written: yield* Fiber.join(joined) };
        }),
        yield* runtime.contextEffect,
      );
      expect(status).toBe("running");
      expect(written).toBe(4);
      const finished = yield* Effect.provideContext(
        importer.overview,
        yield* runtime.contextEffect,
      );
      expect(finished.activity).toMatchObject({
        status: "finished",
        checked: 1,
        total: 1,
        written: 4,
        failed: 0,
      });
      expect(finished.sources[0]).toMatchObject({ transcripts: 1, migrated: 1, nodes: 4 });
    }).pipe(withTestPlatform),
  );

  effectTest.live("leaves a half-written last line for the next pass", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { runtime, project, home } = yield* Effect.promise(() => testRuntime());
      const path = yield* claudePath(home, "cc-1.jsonl");
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
      const importer = yield* Effect.provideContext(Importer, yield* runtime.contextEffect);
      expect(yield* Effect.provideContext(importer.runOnce, yield* runtime.contextEffect)).toBe(4);
      yield* fs.writeFileString(path, `${complete + half}\n`);
      expect(yield* Effect.provideContext(importer.runOnce, yield* runtime.contextEffect)).toBe(1);
    }).pipe(withTestPlatform),
  );

  effectTest.live("registers the folder a conversation ran in as a project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const { runtime, home, base } = yield* Effect.promise(() => testRuntime());
      const folder = pathService.join(base, "another-project");
      yield* fs.makeDirectory(folder);
      yield* fs.writeFileString(
        yield* claudePath(home, "cc-1.jsonl"),
        yield* serialize(claudeLines(folder)),
      );
      const registered = yield* Effect.provideContext(
        Effect.gen(function* () {
          expect(yield* (yield* Importer).runOnce).toBe(4);
          return yield* (yield* Projects).list;
        }),
        yield* runtime.contextEffect,
      );
      const added = registered.find((project) => project.root === folder);
      expect(added).toBeDefined();
      expect(added?.name).toBe("another-project");
      // Registering is what the user asked for, but it never relaxes how tool calls are approved.
      expect(added?.permissionMode).toBe("ask");
    }).pipe(withTestPlatform),
  );

  effectTest.live("names a folder it cannot register, with why", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { runtime, home } = yield* Effect.promise(() => testRuntime());
      yield* fs.writeFileString(
        yield* claudePath(home, "cc-1.jsonl"),
        yield* serialize(claudeLines("/gone/for/good")),
      );
      const overview = yield* Effect.provideContext(
        Effect.gen(function* () {
          const importer = yield* Importer;
          expect(yield* importer.runOnce).toBe(0);
          return yield* importer.overview;
        }),
        yield* runtime.contextEffect,
      );
      expect(overview.unplaced).toEqual([
        { cwd: "/gone/for/good", reason: "not_found", transcripts: 1 },
      ]);
    }).pipe(withTestPlatform),
  );

  // chmod cannot take read access away from root, nor on Windows.
  effectTest.live.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports a transcript it cannot read, reads the others, and tries it again next time",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { runtime, project, home } = yield* Effect.promise(() => testRuntime());
        const unreadable = yield* claudePath(home, "cc-1.jsonl");
        yield* fs.writeFileString(unreadable, yield* serialize(claudeLines(project.root)));
        yield* fs.writeFileString(
          yield* codexPath(home),
          yield* serialize(codexLines(project.root)),
        );
        const permissionScope = yield* Scope.fork(yield* Scope.Scope, "sequential");
        yield* Effect.provideService(
          Effect.acquireRelease(fs.chmod(unreadable, 0o000), () =>
            fs.chmod(unreadable, 0o600).pipe(Effect.orDie),
          ),
          Scope.Scope,
          permissionScope,
        );
        const importer = yield* Effect.provideContext(Importer, yield* runtime.contextEffect);
        {
          // The Claude Code transcript comes first; failing it must not stop the Codex one.
          expect(yield* Effect.provideContext(importer.runOnce, yield* runtime.contextEffect)).toBe(
            1,
          );
          const overview = yield* Effect.provideContext(
            importer.overview,
            yield* runtime.contextEffect,
          );
          expect(
            overview.sources.map(({ name, migrated, failed }) => [name, migrated, failed]),
          ).toEqual([
            ["claude-code", 0, 1],
            ["codex", 1, 0],
          ]);
          expect(overview.failures).toEqual([
            { source: "claude-code", path: unreadable, reason: expect.stringContaining("EACCES") },
          ]);
        }
        yield* Scope.close(permissionScope, Exit.void);
        expect(yield* Effect.provideContext(importer.runOnce, yield* runtime.contextEffect)).toBe(
          4,
        );
        const overview = yield* Effect.provideContext(
          importer.overview,
          yield* runtime.contextEffect,
        );
        expect(overview.failures).toEqual([]);
        expect(overview.sources.map(({ migrated, failed }) => [migrated, failed])).toEqual([
          [1, 0],
          [1, 0],
        ]);
      }).pipe(withTestPlatform),
  );

  effectTest.live("a hidden project still owns its folder's transcripts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { runtime, project, home } = yield* Effect.promise(() => testRuntime());
      yield* fs.writeFileString(
        yield* claudePath(home, "cc-1.jsonl"),
        yield* serialize(claudeLines(project.root)),
      );
      const { visible, all } = yield* Effect.provideContext(
        Effect.gen(function* () {
          const projects = yield* Projects;
          yield* projects.setHidden(project.id, true);
          yield* (yield* Importer).runOnce;
          return { visible: yield* projects.list, all: yield* projects.listAll };
        }),
        yield* runtime.contextEffect,
      );
      // Out of the sidebar, but the conversation went to it rather than registering a second one.
      expect(visible).toEqual([]);
      expect(all.filter((entry) => entry.root === project.root)).toHaveLength(1);
    }).pipe(withTestPlatform),
  );

  effectTest.live("never reads this app's own storage", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const { runtime, project, storage } = yield* Effect.promise(() => testRuntime());
      const directory = pathService.join(storage, "codex", "sessions", "2026", "04", "02");
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(
        pathService.join(directory, "rollout-2026-04-02T02-00-00-cx-1.jsonl"),
        yield* serialize(codexLines(project.root)),
      );
      // The app's own codex home lives under the storage root; its conversations are already nodes.
      expect(
        yield* Effect.provideContext(
          Effect.flatMap(Importer, (importer) => importer.runOnce),
          yield* runtime.contextEffect,
        ),
      ).toBe(0);
    }).pipe(withTestPlatform),
  );

  effectTest.live("indexes what was said today before a migrated backlog", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { runtime, project, session, home } = yield* Effect.promise(() => testRuntime());
      yield* fs.writeFileString(
        yield* claudePath(home, "cc-1.jsonl"),
        yield* serialize(claudeLines(project.root)),
      );
      const indexed = yield* Effect.provideContext(
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
          return (yield* decodeIndexed(
            sqlite
              .prepare(
                "SELECT n.text FROM node_vectors v JOIN nodes n ON n.seq = v.node_seq ORDER BY n.seq",
              )
              .all(),
          )).map((row) => ({ text: row.text, isToday: row.text === today.text }));
        }),
        yield* runtime.contextEffect,
      );
      expect(indexed).toEqual([{ text: "오늘 한 말", isToday: true }]);
    }).pipe(withTestPlatform),
  );

  effectTest.live(
    "reads Codex rollouts too, and queues migrated statements for interpretation",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { runtime, project, home } = yield* Effect.promise(() => testRuntime());
        yield* fs.writeFileString(
          yield* codexPath(home),
          yield* serialize(codexLines(project.root)),
        );
        const { pending, rendered } = yield* Effect.provideContext(
          Effect.gen(function* () {
            yield* (yield* Importer).runOnce;
            const { sqlite } = yield* Database;
            const sessions = yield* (yield* Sessions).list(project.id);
            const migrated = sessions.find((session) => session.importedFrom === "codex")!;
            expect(migrated.createdAt).toBe("2026-04-02T02:00:00.000Z");
            const nodes = yield* Nodes;
            return {
              pending: (yield* decodeCount(
                sqlite
                  .prepare("SELECT count(*) AS count FROM interpret_jobs WHERE status = 'pending'")
                  .get(),
              )).count,
              rendered: sessionMessages(nodes.session(migrated.id), () => []),
            };
          }),
          yield* runtime.contextEffect,
        );
        expect(pending).toBe(1);
        expect(rendered).toHaveLength(1);
        expect(rendered[0]?.role).toBe("user");
        expect(rendered[0]?.parts).toEqual([{ type: "text", content: "이어서" }]);
      }).pipe(withTestPlatform),
  );
});
