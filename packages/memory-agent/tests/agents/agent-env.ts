import {
  Cause,
  Deferred,
  Effect,
  FileSystem,
  Function as EffectFunction,
  Random,
  Schema,
} from "effect";
import { AgentChat } from "../../src/agent/chat.ts";
import { messageText } from "../../src/agent/compaction.ts";
import { RunStore } from "../../src/loop/store.ts";
import { type PermissionMode, Projects } from "../../src/projects/projects.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import type { ScriptedInvocation } from "../../src/testing/scripted-model.ts";
import { runTurn, streamedText } from "../support/chat-client.ts";
import { defaultTestResponder } from "../support/provider.ts";
import { sqlGet } from "../support/sql.ts";
import { TestEnv } from "../support/test-env.ts";
import { type WaitCondition, waitUntil } from "../support/wait-until.ts";

/** A Promise-returning SDK call whose rejection stays in the error channel. */
export const sdk = <A>(operation: () => A | PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });

export const until: {
  (
    what: string,
  ): <E = never, R = never>(condition: WaitCondition<E, R>) => ReturnType<typeof untilBody<E, R>>;
} & typeof untilBody = EffectFunction.dual(2, untilBody);
function untilBody<E = never, R = never>(condition: WaitCondition<E, R>, what: string) {
  return waitUntil(condition, what, 6_000);
}

const JsonText = Schema.fromJsonString(Schema.Unknown);

/** JSON text of any test value, as the SDK and HTTP bodies carry it. */
export const encodeJson = <A>(value: A) => Schema.encodeEffect(JsonText)(value);

/** Run against the agent that is open now, so helpers keep working across `env.reopen`. */
export const current = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(TestEnv, (env) => env.use(effect));

/** Each test gets its own session in the shared agent. */
export const freshSession = Effect.gen(function* () {
  const { project } = yield* TestEnv;
  return (yield* current(Effect.flatMap(Sessions, (sessions) => sessions.create(project.id)))).id;
});

/**
 * A project of the test's own, for tests that write into the project folder or change its
 * permission mode, with one session in it.
 */
export const freshProject = Effect.fnUntraced(function* (mode: PermissionMode = "ask") {
  const { base } = yield* TestEnv;
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectory({ directory: base, prefix: "project-" });
  const projects = yield* current(Projects);
  const project = yield* projects.add(root);
  yield* projects.setPermissionMode(project.id, mode);
  const session = yield* current(
    Effect.flatMap(Sessions, (sessions) => sessions.create(project.id)),
  );
  return { project, sessionId: session.id };
});

/**
 * Post one user message to the open agent and read the answer once the run ends. Run IDs are
 * global, so they carry the session.
 */
export const send = Effect.fnUntraced(function* (sessionId: string, text: string) {
  const runId = `${sessionId}:${(yield* Random.nextInt).toString(36)}`;
  return streamedText(yield* runTurn(sessionId, runId, text));
});

const Busy = Schema.Struct({ busy: Schema.Finite });
const RunState = Schema.fromJsonString(Schema.Struct({ running: Schema.NullOr(Schema.Unknown) }));

/**
 * Waits until the session's delegated work and the follow-ups it started are over: no attempt or
 * run is going and every notification reached a run that ended. A follow-up takes its
 * notifications before it counts as live, and a run ends after its record says so, so both the
 * record and the agent's own view of the live run decide when the next message can be sent.
 */
export const settled = (sessionId: string) =>
  until(
    Effect.zipWith(
      Effect.flatMap(
        sqlGet(
          `SELECT
             (SELECT count(*) FROM agent_run_attempts a JOIN work_tasks t ON t.id = a.task_id
              WHERE t.origin_session_id = ?
                AND a.status IN ('queued', 'running', 'waiting', 'blocked'))
             + (SELECT count(*) FROM parent_notifications n
                WHERE n.origin_session_id = ? AND NOT EXISTS (
                  SELECT 1 FROM chat_runs r
                  WHERE r.run_id = n.delivered_to_run_id AND r.status <> 'running')) AS busy`,
          sessionId,
          sessionId,
        ),
        Schema.decodeUnknownEffect(Busy),
      ),
      current(
        Effect.flatMap(AgentChat, (agent) => agent.status(sessionId, null)).pipe(
          Effect.flatMap((response) => sdk(() => response.text())),
          Effect.flatMap(Schema.decodeEffect(RunState)),
        ),
      ),
      ({ busy }, { running }) => busy === 0 && running === null,
    ),
    "delegated work to settle",
  );

/** Post a message that delegates work, then read the answer of the follow-up that ended it. */
export const delegate = Effect.fnUntraced(function* (sessionId: string, text: string) {
  yield* send(sessionId, text);
  yield* settled(sessionId);
  const messages = yield* current(Effect.flatMap(RunStore, (store) => store.thread(sessionId)));
  const last = messages.findLast((message) => message.role === "assistant");
  return last === undefined ? "" : messageText(last);
});

interface Delayed {
  readonly user: string;
  readonly gate: Deferred.Deferred<void>;
}

/** Delayed model turns waiting for the running test; tests in a file run one at a time. */
const delayed: Delayed[] = [];

const releaseWhere = Effect.fnUntraced(function* (matches: (entry: Delayed) => boolean) {
  const released = delayed.filter(matches);
  released.forEach((entry) => delayed.splice(delayed.indexOf(entry), 1));
  yield* Effect.forEach(released, ({ gate }) => Deferred.succeed(gate, undefined));
});

/** The default model, except that a turn it would delay waits for the test instead of a timer. */
export const heldDefaultTurn = Effect.fnUntraced(function* (invocation: ScriptedInvocation) {
  const turn = yield* sdk(() => defaultTestResponder(invocation));
  if (turn.delayMs === undefined) return turn;
  const { delayMs: _delayMs, ...ready } = turn;
  const gate = yield* Deferred.make<void>();
  const user = invocation.history.findLast((message) => message.role === "user");
  delayed.push({ user: user === undefined ? "" : messageText(user), gate });
  return { ...ready, waitFor: Deferred.await(gate) };
});

/**
 * The test's view of held model turns. `waitFor` observes that turns whose user text contains
 * `text` have started; `release` lets them finish. Ending the test lets every held turn go.
 */
export const heldTurns = Effect.acquireRelease(
  Effect.succeed({
    waitFor: (text: string, count = 1) =>
      until(
        () => delayed.filter((entry) => entry.user.includes(text)).length >= count,
        `${count} held turn(s) for ${text}`,
      ),
    release: (text: string, count = 1) =>
      until(
        () => delayed.filter((entry) => entry.user.includes(text)).length >= count,
        `${count} held turn(s) for ${text}`,
      ).pipe(Effect.andThen(releaseWhere((entry) => entry.user.includes(text)))),
  }),
  () => releaseWhere(() => true),
);
