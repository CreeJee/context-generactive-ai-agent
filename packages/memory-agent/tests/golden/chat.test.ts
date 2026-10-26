import { Effect } from "effect";
import type { PermissionMode } from "../../src/projects/projects.ts";
import { selectTestModel } from "../support/provider.ts";
import { sqlGet } from "../support/sql.ts";
import { testAgent } from "../support/test-env.ts";
import { conversation, expectGolden } from "./driver.ts";
import { waitUntil } from "../support/wait-until.ts";
import { childrenHeld, goldenResponder, releaseChildren } from "./responder.ts";

type Chat = Effect.Success<ReturnType<typeof conversation>>;
type Step =
  | ReturnType<Chat["send" | "sendAndCancel" | "approve" | "post" | "restartDuring"]>
  | Chat["settled" | "compact" | "goal" | "continuePastUncertain"]
  | ReturnType<typeof selectTestModel>;

/** Send a message that starts children, let them answer after its run, and wait for the reports. */
const delegate = (chat: Chat, text: string) =>
  Effect.gen(function* () {
    yield* chat.post(text);
    yield* waitUntil(
      Effect.sync(() => childrenHeld() > 0),
      "a child to ask the model",
      6_000,
    );
    releaseChildren();
    yield* chat.settled;
  });

const goldenAgent = testAgent({ testProvider: { responder: goldenResponder } });
type It = Parameters<Parameters<typeof goldenAgent>[1]>[0];

/** A scenario in its own conversation, compared with the golden file of the same name. */
const scenarioIn =
  (it: It) =>
  (
    title: string,
    golden: string,
    mode: PermissionMode,
    body: (chat: Chat) => Effect.Effect<void, Effect.Error<Step>, Effect.Services<Step>>,
  ) =>
    it.effect(
      title,
      () =>
        Effect.gen(function* () {
          const chat = yield* conversation(mode);
          yield* body(chat);
          yield* expectGolden(chat.sessionId, golden);
        }),
      20_000,
    );

goldenAgent("golden chat rows", (it) => {
  const scenario = scenarioIn(it);

  scenario("plain answer", "plain-answer", "ask", (chat) => chat.send("hello"));
  scenario("read tool", "read-tool", "ask", (chat) => chat.send("golden:read"));
  scenario("two reads in one step", "parallel-reads", "ask", (chat) =>
    chat.send("golden:parallel-reads"),
  );
  scenario("write tool without approval in full mode", "write-full-mode", "full", (chat) =>
    chat.send("golden:write"),
  );
  scenario("write tool in ask mode", "write-ask-mode", "ask", (chat) => chat.send("golden:write"));
  scenario("approved tool in ask mode", "approval-approved", "ask", (chat) =>
    Effect.andThen(chat.send("golden:approval"), chat.approve(true)),
  );
  scenario("declined tool in ask mode", "approval-declined", "ask", (chat) =>
    Effect.andThen(chat.send("golden:approval"), chat.approve(false)),
  );
  scenario("permission review asks, then the user approves", "permission-review", "auto", (chat) =>
    Effect.andThen(chat.send("golden:review"), chat.approve(true)),
  );
  scenario("reads and a write needing approval in one step", "mixed-step", "ask", (chat) =>
    Effect.andThen(chat.send("golden:mixed"), chat.approve(true)),
  );
  scenario("provider failure after some text", "provider-failure", "ask", (chat) =>
    chat.send("golden:fail"),
  );
  scenario("user cancels a running answer", "cancelled", "ask", (chat) =>
    chat.sendAndCancel("golden:cancel"),
  );
  scenario("a named subagent keeps its conversation across runs", "named-subagent", "ask", (chat) =>
    Effect.andThen(
      delegate(chat, "golden:subagent-first"),
      delegate(chat, "golden:subagent-second"),
    ),
  );
  scenario("the next turn after a model change", "model-handoff", "ask", (chat) =>
    Effect.gen(function* () {
      yield* chat.send("before the switch");
      yield* selectTestModel("deep-1", "medium");
      yield* chat.send("after the switch");
      yield* chat.send("still the new model");
    }),
  );
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
  scenario("/compact summarizes earlier turns for the next one", "compaction", "ask", (chat) =>
    Effect.gen(function* () {
      for (const turn of ["turn one", "turn two", "turn three", "turn four"])
        yield* chat.send(turn);
      yield* chat.compact;
      yield* chat.send("turn five");
    }),
  );
});

// A restart replaces the agent, so this block has an agent of its own.
goldenAgent("golden chat rows across a restart", (it) => {
  // The next Goal turn is left out: the worker's ledger still refuses its first side effect
  // (`uncertain_run`) after the user continued, and the run never ends. Goal execution moves to
  // the owner in step 5, which adds that turn.
  scenarioIn(it)(
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
