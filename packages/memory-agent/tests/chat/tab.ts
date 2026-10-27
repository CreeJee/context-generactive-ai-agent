import { Cause, Deferred, Effect, MutableHashMap, Option } from "effect";
import { AgentChat } from "../../src/agent/chat.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import type { ScriptedResponder } from "../../src/testing/scripted-adapter.ts";
import { defaultTestResponder } from "../support/provider.ts";
import { TestEnv } from "../support/test-env.ts";
import { waitUntil } from "../support/wait-until.ts";

/** A Promise-returning SDK call whose rejection stays in the error channel. */
export const sdk = <A>(operation: () => A | PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });

export const json = (response: Response) => sdk(() => response.json());

export const until = Effect.fnUntraced(function* (condition: () => boolean, what: string) {
  return yield* waitUntil(condition, what, 6_000);
});

/** Run against the agent that is open now, so helpers keep working across `env.reopen`. */
export const current = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(TestEnv, (env) => env.use(effect));

export const agentChat = current(AgentChat);

/** Each test gets its own session in the shared agent. */
export const freshSession = Effect.gen(function* () {
  const { project } = yield* TestEnv;
  return (yield* current(Effect.flatMap(Sessions, (sessions) => sessions.create(project.id)))).id;
});

export const userTexts = (sessionId: string) =>
  current(
    Effect.flatMap(Nodes, (nodes) =>
      Effect.map(nodes.session(sessionId), (session) =>
        session.filter((node) => node.kind === "user").map((node) => node.text),
      ),
    ),
  );

/** The model invocations of one session; the provider is shared by the whole block. */
export const invocationsOf = Effect.fnUntraced(function* (sessionId: string) {
  const { provider } = yield* TestEnv;
  return () =>
    (provider?.adapter.invocations ?? []).filter((invocation) => invocation.threadId === sessionId);
});

const gates = MutableHashMap.empty<string, Deferred.Deferred<void>>();

/** The default model, except that a held session's delayed turns wait for that session's gate. */
export const gatedResponder: ScriptedResponder = (invocation) =>
  Effect.gen(function* () {
    const turn = yield* sdk(() => defaultTestResponder(invocation));
    const gate = MutableHashMap.get(gates, invocation.threadId ?? "");
    if (turn.delayMs === undefined || Option.isNone(gate)) return turn;
    const { delayMs: _delayMs, ...gated } = turn;
    return { ...gated, waitFor: Deferred.await(gate.value) };
  });

/** Hold the session's delayed model turns until the returned Effect runs, or the test ends. */
export const holdDelayedTurns = (sessionId: string) =>
  Effect.acquireRelease(
    Effect.tap(Deferred.make<void>(), (gate) =>
      Effect.sync(() => MutableHashMap.set(gates, sessionId, gate)),
    ),
    (gate) =>
      Effect.andThen(
        Effect.sync(() => MutableHashMap.remove(gates, sessionId)),
        Deferred.succeed(gate, undefined),
      ),
  ).pipe(Effect.map((gate) => Deferred.succeed(gate, undefined)));
