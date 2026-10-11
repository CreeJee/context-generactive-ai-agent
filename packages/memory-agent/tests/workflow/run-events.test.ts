import { Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import { Database } from "../../src/db/database.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { workflowRunBindings } from "../../src/workflow/run-bindings.ts";
import { workflowRunEvents } from "../../src/workflow/run-events.ts";
import { Workflows } from "../../src/workflow/workflow.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";

testAgent()((it) => {
  it.effect(
    "the owner journals bound output with idempotent keys and replays it after reopening",
    () =>
      Effect.gen(function* () {
        const env = yield* TestEnv;
        const db = yield* Database;
        const other = yield* (yield* Sessions).create(env.project.id);
        yield* (yield* Workflows).updateGoal(env.session.id, {
          statement: "Pin a recorded run",
          outcomes: ["Replay output"],
          constraints: [],
          nonGoals: [],
          assumptions: [],
          openQuestions: [],
          status: "active",
        });
        const latest = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.Finite }))(
          db.sqlite
            .prepare(
              "SELECT id FROM workflow_state_revisions WHERE session_id = ? ORDER BY id DESC LIMIT 1",
            )
            .get(env.session.id),
        );
        expect(workflowRunBindings(db).bind(env.session.id, "journaled", latest.id).status).toBe(
          "bound",
        );
        const events = workflowRunEvents(db);
        expect(() =>
          events.append(other.id, "journaled", "chunk:0", "chunk", { text: "stolen" }),
        ).toThrow("Run event has no owner binding");
        const first = events.append(env.session.id, "journaled", "chunk:0", "chunk", {
          text: "before restart",
        });
        expect(
          events.append(env.session.id, "journaled", "chunk:0", "chunk", {
            text: "before restart",
          }),
        ).toEqual(first);
        expect(() =>
          events.append(env.session.id, "journaled", "chunk:0", "chunk", { text: "different" }),
        ).toThrow("Run event key was reused for different content");
        const second = events.append(env.session.id, "journaled", "chunk:1", "chunk", {
          text: "after first",
        });
        expect(second.cursor).toBeGreaterThan(first.cursor);
        expect(events.replay(other.id, "journaled")).toEqual([]);
        expect(events.replay(env.session.id, "journaled", first.cursor)).toEqual([second]);
        expect(db.sqlite.prepare("SELECT count(*) AS n FROM workflow_run_events").get()).toEqual({
          n: 2,
        });
        yield* env.reopen;
        const replay = workflowRunEvents(yield* env.use(Database));
        expect(replay.replay(env.session.id, "journaled")).toEqual([first, second]);
        expect(() => replay.replay(env.session.id, "journaled", -1)).toThrow("Invalid run cursor");
      }),
  );
});
