import { Cause, Deferred, Effect, FileSystem, Random, Schema } from "effect";
import { AgentChat } from "../../src/agent/chat.ts";
import { messageText } from "../../src/messages/text.ts";
import { type PermissionMode, Projects } from "../../src/projects/projects.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import type { AdapterInvocation } from "../../src/testing/scripted-adapter.ts";
import { isTruthy } from "../../src/truthy.ts";
import { defaultTestResponder } from "../support/provider.ts";
import { TestEnv } from "../support/test-env.ts";
import { type WaitCondition, waitUntil } from "../support/wait-until.ts";

/** A Promise-returning SDK call whose rejection stays in the error channel. */
export const sdk = <A>(operation: () => A | PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });

export const until = <E = never, R = never>(condition: WaitCondition<E, R>, what: string) =>
  waitUntil(condition, what, 6_000);

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

const Chunk = Schema.fromJsonString(
  Schema.Struct({ type: Schema.String, delta: Schema.optional(Schema.String) }),
);

/** The assistant text streamed in a chat response. */
export const answerOf = Effect.fnUntraced(function* (response: Response) {
  const lines = (yield* sdk(() => response.text()))
    .split("\n")
    .filter((line) => line.startsWith("data: "));
  const chunks = yield* Effect.forEach(lines, (line) => Schema.decodeEffect(Chunk)(line.slice(6)));
  return chunks
    .flatMap((chunk) =>
      chunk.type === "TEXT_MESSAGE_CONTENT" && isTruthy(chunk.delta) ? [chunk.delta] : [],
    )
    .join("");
});

/** Post one user message to the open agent. Run IDs are global, so they carry the session. */
export const post = Effect.fnUntraced(function* (sessionId: string, text: string) {
  const runId = `${sessionId}:${(yield* Random.nextInt).toString(36)}`;
  const body = yield* encodeJson({
    threadId: sessionId,
    runId,
    messages: [{ id: `${runId}:user`, role: "user", content: text }],
    tools: [],
    context: [],
  });
  return yield* current(
    Effect.flatMap(AgentChat, (agent) =>
      agent.handle(
        new Request("http://127.0.0.1/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }),
        sessionId,
      ),
    ),
  );
});

/** Post one user message and read the answer once the run ends. */
export const send = Effect.fnUntraced(function* (sessionId: string, text: string) {
  return yield* answerOf(yield* post(sessionId, text));
});

interface Delayed {
  readonly user: string;
  readonly gate: Deferred.Deferred<void>;
}

/** Delayed model turns waiting for the running test; tests in a file run one at a time. */
const delayed: Delayed[] = [];

const releaseWhere = Effect.fnUntraced(function* (matches: (entry: Delayed) => boolean) {
  const released = delayed.filter(matches);
  for (const entry of released) delayed.splice(delayed.indexOf(entry), 1);
  yield* Effect.forEach(released, ({ gate }) => Deferred.succeed(gate, undefined));
});

/** The default model, except that a turn it would delay waits for the test instead of a timer. */
export const heldDefaultTurn = Effect.fnUntraced(function* (invocation: AdapterInvocation) {
  const turn = yield* sdk(() => defaultTestResponder(invocation));
  if (turn.delayMs === undefined) return turn;
  const { delayMs: _delayMs, ...ready } = turn;
  const gate = yield* Deferred.make<void>();
  const user = invocation.messages.findLast((message) => message.role === "user");
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
