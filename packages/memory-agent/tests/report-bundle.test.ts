import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vite-plus/test";
import { ReportBundle } from "../src/report/bundle-contract.ts";
import { bundleLimits, collectReportBundle } from "../src/report/bundle.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { TestEnv, testAgent } from "./support/test-env.ts";

// The OpenAI project key shape secretlint knows (the `T3BlbkFJ` marker), so it is found without a name.
const keyBody = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6A7b8C9d0E1f2G3h4I5j6K7";
const secret = `sk-proj-${keyBody}T3BlbkFJ${keyBody}`;
const encodeBundle = Schema.encodeEffect(Schema.fromJsonString(ReportBundle));

/** A session with `runs` runs, each with a message and a tool call; every fifth call failed. */
const seededSession = Effect.fnUntraced(function* (runs: number) {
  const { project } = yield* TestEnv;
  const sql = yield* SqlClient.SqlClient;
  const session = yield* (yield* Sessions).create(project.id);
  for (let index = 1; index <= runs; index++) {
    const run = `${session.id}-run-${index}`;
    const failed = index % 5 === 0;
    yield* sql`INSERT INTO chat_runs (run_id, thread_id, status, started_at, finished_at, error, error_code)
      VALUES (${run}, ${session.id}, ${failed ? "failed" : "completed"}, ${1_000 + index},
        ${1_500 + index}, ${failed ? `upstream said API_KEY=${secret}` : null},
        ${failed ? "provider_failed" : null})`;
    const at = (offset: number) => new Date(1_000 + index * 10 + offset).toISOString();
    const node = (
      id: string,
      kind: string,
      text: string,
      detail: Readonly<Record<string, string | boolean>>,
      offset: number,
    ) =>
      sql`INSERT INTO nodes (id, project_id, session_id, run_id, kind, text, detail, created_at)
        VALUES (${`${run}-${id}`}, ${project.id}, ${session.id}, ${run}, ${kind}, ${text},
          ${JSON.stringify(detail)}, ${at(offset)})`;
    yield* node("ask", "user", `read file ${index}`, {}, 0);
    yield* node(
      "call",
      "tool_call",
      `{"path":"f${index}"}`,
      { toolCallId: `c${index}`, toolName: "read_file" },
      1,
    );
    yield* node(
      "result",
      "tool_result",
      failed ? `ENOENT f${index} ${"x".repeat(7_000)}` : `contents ${secret}`,
      { toolCallId: `c${index}`, toolName: "read_file", ok: !failed },
      2,
    );
  }
  return { project, session: { id: session.id, title: null } };
});

testAgent()("report evidence bundle", (it) => {
  it.effect("holds the latest runs, numbered from the first, with secrets hidden", () =>
    Effect.gen(function* () {
      const { project, session } = yield* seededSession(400);
      const bundle = yield* collectReportBundle(project, session);

      expect(bundle.session.runCount).toBe(400);
      expect(bundle.timeline.truncated).toBe(true);
      expect(bundle.timeline.items.map((run) => run.seq)).toEqual(
        Array.from(
          { length: bundleLimits.runs },
          (_, index) => 400 - bundleLimits.runs + 1 + index,
        ),
      );
      const last = bundle.timeline.items.at(-1);
      expect(last).toMatchObject({
        seq: 400,
        status: "failed",
        error: { code: "provider_failed" },
      });
      // The call and its result are one event; a failed result keeps the longer limit.
      const call = last?.events.find((event) => event._tag === "ToolCall");
      expect(call).toMatchObject({ seq: 1, name: "read_file", result: { ok: false } });
      if (call?._tag !== "ToolCall" || call.result === null) throw new Error("missing call");
      expect(call.result.text).toEqual({
        text: expect.stringContaining("ENOENT f400"),
        cut: true,
      });
      expect(call.result.text.text).toHaveLength(bundleLimits.failureChars);

      const json = yield* encodeBundle(bundle);
      expect(json).not.toContain(secret);
      expect(json).toContain("API_KEY=");
      // Local ids leave only as hashes.
      expect(json).not.toContain(session.id);
    }),
  );

  it.effect("reads only the session's own runs and nodes", () =>
    Effect.gen(function* () {
      const { project, session } = yield* seededSession(2);
      yield* seededSession(3);
      const bundle = yield* collectReportBundle(project, session);
      expect(bundle.session.runCount).toBe(2);
      expect(bundle.timeline.items.map((run) => run.events.length)).toEqual([2, 2]);
      expect(bundle.unlinked.status).toBe("empty");
    }),
  );
});
