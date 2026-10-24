import { it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { ItemInterpretation } from "../src/improve/contracts.ts";
import { EmbedderRuntime, Embedder } from "../src/memory/embedding/embedder.ts";
import { parseInterpretation } from "../src/improve/interpret.ts";
import { improvementItems } from "../src/improve/items.ts";
import { improvementReport } from "../src/improve/report.ts";
import { collectSignals, failureSignature, Signal } from "../src/improve/signals.ts";
import { sqlRun } from "./support/sql.ts";

/** Texts about logging point one way, everything else the other. */
const embedder = Layer.succeed(Embedder, {
  identity: "fixture",
  dimensions: 2,
  embed: (texts) =>
    Effect.succeed(texts.map((text) => Float32Array.from(text.includes("로그") ? [1, 0] : [0, 1]))),
  runtime: () => EmbedderRuntime.other(),
});

const run = Effect.fnUntraced(function* <A, E>(
  program: Effect.Effect<A, E, SqlClient.SqlClient | Embedder>,
) {
  const services = yield* Layer.build(Layer.merge(Database.layer(":memory:"), embedder));
  return yield* Effect.provideContext(program, services);
}, Effect.scoped);

const node = (id: string, kind: string, text: string, createdAt: string, detail = "{}") =>
  sqlRun(
    `INSERT INTO nodes (id, project_id, session_id, kind, text, detail, created_at)
     VALUES (?, 'p1', 's1', ?, ?, ?, ?)`,
    id,
    kind,
    text,
    detail,
    createdAt,
  );
const correction = (user: string, text: string, corrected: string, createdAt: string) =>
  Effect.gen(function* () {
    yield* node(`${user}-target`, "assistant", corrected, createdAt);
    yield* node(user, "user", text, createdAt);
    yield* sqlRun(
      `INSERT INTO edges (from_id, to_id, kind, origin, weight, created_at)
       VALUES (?, ?, 'corrects', 'llm', 1, ?)`,
      user,
      `${user}-target`,
      createdAt,
    );
  });
const failed = (id: string, text: string, createdAt: string) =>
  node(
    id,
    "tool_result",
    text,
    createdAt,
    JSON.stringify({ toolName: "Bash", ok: false, importedFrom: "claude-code" }),
  );

describe("project improvement discovery", () => {
  it("keeps user and model text from adding headings to the report", () => {
    const report = improvementReport(
      {
        repository: "/repo",
        items: [
          {
            id: "i1",
            repository: "/repo",
            source: "correction",
            title: "묶음",
            count: 2,
            evidence: ["u1"],
            excerpts: ["## 끼어든 제목\n본문"],
            latestAt: null,
            interpretation: ItemInterpretation.cases.interpreted.make({
              title: "제목\n## 모델 제목",
              problem: "문제\n## 모델 문단",
              rule: "규칙",
              change: "변경",
              acceptance: "확인",
            }),
          },
        ],
      },
      "2026-10-20T00:00:00.000Z",
    );
    expect(report.split("\n").filter((line) => line.startsWith("## "))).toEqual([
      "## 1. 제목 ## 모델 제목",
    ]);
  });

  it.effect("reads a fenced verdict and drops what the model skips", () =>
    Effect.gen(function* () {
      const improve = yield* parseInterpretation(
        '```json\n{"_tag":"improve","title":"t","problem":"p","rule":"r","change":"c","acceptance":"a"}\n```',
      );
      expect(Option.exists(improve, ItemInterpretation.guards.interpreted)).toBe(true);
      expect(yield* parseInterpretation('{"_tag":"skip","reason":"평범한 요청"}')).toEqual(
        Option.none(),
      );
    }),
  );

  it("groups failures by cause, not by the path or number they mention", () => {
    expect(failureSignature("Error: can't find module 'foo'")).toBe(
      failureSignature("Error: can't find module 'bar'"),
    );
    expect(failureSignature("Exit code 1\nError: cannot open /a/b/c.ts at line 12")).toBe(
      failureSignature("Error: cannot open /x/y.ts at line 3"),
    );
    expect(
      failureSignature(
        "Permission to use Bash with command cd /repo && sed -n 1,2p f has been denied.",
      ),
    ).toBe(failureSignature("Permission to use Bash with command head -5 f has been denied."));
  });

  it.effect("finds repeated corrections and tool failures within the lookback window", () =>
    run(
      Effect.gen(function* () {
        yield* sqlRun(
          "INSERT INTO projects (id, root, name, created_at) VALUES ('p1', '/repo', 'p1', '2026-10-01')",
        );
        yield* sqlRun(
          "INSERT INTO sessions (id, project_id, title, created_at) VALUES ('s1', 'p1', NULL, '2026-10-01')",
        );
        const recent = "2026-10-10T00:00:00.000Z";
        yield* correction("u1", "로그는 JSON Lines로 남겨", "logfmt로 남겼어요", recent);
        yield* correction("u2", "로그 형식 다시 JSON Lines로", "평문으로 남겼어요", recent);
        yield* correction("u3", "테스트는 vp test로 돌려", "npm test를 돌렸어요", recent);
        // Before the window: not counted, though it is about logging too.
        yield* correction("u0", "로그 레벨은 info", "debug로 했어요", "2026-01-01T00:00:00.000Z");
        yield* failed("f1", "Error: cannot open /a/one.ts", recent);
        yield* failed("f2", "Exit code 2\nError: cannot open /b/two.ts", recent);
        yield* failed("f3", "Error: cannot open /c/three.ts", recent);
        yield* failed("f4", "Error: timeout after 30s", recent);
        // This app's own tool asking the agent to retry, and a call the user declined: neither counts.
        yield* node(
          "own",
          "tool_result",
          "Error: cannot open /e.ts",
          recent,
          '{"toolName":"read_file","ok":false}',
        );
        yield* failed("declined", "The user doesn't want to proceed with this tool use.", recent);
        yield* node(
          "ok",
          "tool_result",
          "Error: cannot open /d.ts",
          recent,
          '{"toolName":"Bash","ok":true}',
        );

        const signals = yield* collectSignals(["p1"], "2026-10-01T00:00:00.000Z");
        expect(signals.filter(Signal.guards.correction)).toHaveLength(3);
        expect(signals.filter(Signal.guards.tool_failure)).toHaveLength(4);
        expect(signals).toHaveLength(7);
        const items = yield* improvementItems("/repo", signals);
        expect(
          items.map(({ source, count, evidence }) => ({
            source,
            count,
            evidence: [...evidence].sort(),
          })),
        ).toEqual([
          { source: "tool_failure", count: 3, evidence: ["f1", "f2", "f3"] },
          { source: "correction", count: 2, evidence: ["u1", "u2"] },
        ]);
      }),
    ),
  );
});
