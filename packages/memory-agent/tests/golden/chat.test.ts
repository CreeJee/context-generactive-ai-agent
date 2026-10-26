import { Effect } from "effect";
import { sqlGet } from "../support/sql.ts";
import { chatScenarios, goldenAgent, scenarioIn } from "./scenarios.ts";

goldenAgent()("golden chat rows", (it) => {
  chatScenarios(it, "");
  const scenario = scenarioIn(it, "");
  scenario("a Goal run reads and writes in one step", "goal-tools", "ask", (chat) =>
    Effect.andThen(chat.goal, chat.send("golden:goal-tools")),
  );
  scenario("a Goal run waits for approval and resumes", "goal-approval", "ask", (chat) =>
    Effect.gen(function* () {
      yield* chat.goal;
      yield* chat.send("golden:goal-approval");
      yield* chat.approve(true);
    }),
  );
});

// A restart replaces the agent, so this block has an agent of its own.
goldenAgent()("golden chat rows across a restart", (it) => {
  // The next Goal turn is left out: the worker's ledger still refuses its first side effect
  // (`uncertain_run`) after the user continued, and the run never ends. Goal execution moves to
  // the owner in step 5, which adds that turn.
  scenarioIn(it, "")(
    "a Goal run cut by a restart is confirmed by the user",
    "goal-restart",
    "full",
    (chat) =>
      Effect.gen(function* () {
        yield* chat.goal;
        // run_skill runs a sh skill as a background shell; restart once that shell is running.
        yield* chat.restartDuring(
          "golden:goal-restart",
          Effect.map(
            sqlGet(
              `SELECT count(*) AS shells FROM agent_run_attempts a
               JOIN work_tasks t ON t.id = a.task_id
               WHERE t.origin_session_id = ? AND t.parent_tool_call_id LIKE 'goal-run@%'
                 AND a.status = 'running'`,
              chat.sessionId,
            ),
            (row) => Number(row?.["shells"] ?? 0) > 0,
          ),
          "the background shell to run",
        );
        yield* chat.continuePastUncertain;
      }),
  );
});
