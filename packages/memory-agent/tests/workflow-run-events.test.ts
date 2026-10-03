import { Effect, Schema } from "effect";
import { expect, test } from "vite-plus/test";
import { Database } from "../src/db/database.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { workflowRunBindings } from "../src/workflow/run-bindings.ts";
import { workflowRunEvents } from "../src/workflow/run-events.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";

test("the owner journals bound output with idempotent keys and replays it after reopening", async () => {
  const context = await testRuntime();
  const { db, workflows, sessions } = await context.runtime.runPromise(
    Effect.all({ db: Database, workflows: Workflows, sessions: Sessions }),
  );
  const other = await context.runtime.runPromise(sessions.create(context.project.id));
  await context.runtime.runPromise(
    workflows.updateGoal(context.session.id, {
      statement: "Pin a recorded run",
      outcomes: ["Replay output"],
      constraints: [],
      nonGoals: [],
      assumptions: [],
      openQuestions: [],
      status: "active",
    }),
  );
  const latest = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Finite }))(
    db.sqlite
      .prepare(
        "SELECT id FROM workflow_state_revisions WHERE session_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(context.session.id),
  );
  expect(workflowRunBindings(db).bind(context.session.id, "journaled", latest.id).status).toBe(
    "bound",
  );
  const events = workflowRunEvents(db);
  expect(() =>
    events.append(other.id, "journaled", "chunk:0", "chunk", { text: "stolen" }),
  ).toThrow("Run event has no owner binding");
  const first = events.append(context.session.id, "journaled", "chunk:0", "chunk", {
    text: "before restart",
  });
  expect(
    events.append(context.session.id, "journaled", "chunk:0", "chunk", { text: "before restart" }),
  ).toEqual(first);
  expect(() =>
    events.append(context.session.id, "journaled", "chunk:0", "chunk", { text: "different" }),
  ).toThrow("Run event key was reused for different content");
  const second = events.append(context.session.id, "journaled", "chunk:1", "chunk", {
    text: "after first",
  });
  expect(second.cursor).toBeGreaterThan(first.cursor);
  expect(events.replay(other.id, "journaled")).toEqual([]);
  expect(events.replay(context.session.id, "journaled", first.cursor)).toEqual([second]);
  expect(db.sqlite.prepare("SELECT count(*) AS n FROM workflow_run_events").get()).toEqual({
    n: 2,
  });
  const reopened = await context.reopen();
  const replay = workflowRunEvents(await reopened.runPromise(Database));
  expect(replay.replay(context.session.id, "journaled")).toEqual([first, second]);
  expect(() => replay.replay(context.session.id, "journaled", -1)).toThrow("Invalid run cursor");
});
