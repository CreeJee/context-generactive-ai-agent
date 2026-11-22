import { NodeCrypto } from "@effect/platform-node";
import { Effect, Layer, Option, Stream } from "effect";
import { HttpServer } from "effect/http";
import { HttpApiTest } from "effect/http-api";
import { type AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { ChatApi, SameSite } from "../../src/api/chat-api.ts";
import { ChatApiHandlers } from "../../src/api/chat-api-live.ts";
import { ChatApiClient, chatSessions } from "../../src/api/chat-session.ts";
import { selectTestModel } from "../support/provider.ts";
import { testAgent } from "../support/test-env.ts";
import { agentChat, freshSession, invocationsOf } from "./tab.ts";

const sameSite = Layer.succeed(SameSite, (httpEffect) => httpEffect);

/** A page's session atoms, calling the open agent's chat API in-process. */
const pageSessions = Effect.gen(function* () {
  const handlers = yield* Layer.build(
    ChatApiHandlers.pipe(
      Layer.provide(Layer.succeed(AgentChat, yield* agentChat)),
      Layer.provideMerge(sameSite),
      Layer.merge(HttpServer.layerServices),
    ),
  );
  const client = yield* HttpApiTest.groups(ChatApi, ["chat"]).pipe(Effect.provideContext(handlers));
  return chatSessions(
    Atom.runtime(Layer.merge(Layer.succeed(ChatApiClient, client), NodeCrypto.layer)),
  );
});

const done = <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
  Atom.getResult(atom, { suspendOnWaiting: true });

testAgent({ testProvider: {} })("chat session atoms", (it) => {
  it.effect("a sent turn shows its run, and a refused turn goes back to the page", () =>
    Effect.gen(function* () {
      yield* selectTestModel();
      const session = yield* freshSession;
      const atoms = (yield* pageSessions)(session);
      const shown = Effect.map(
        Atom.get(atoms.state),
        Option.map(({ view }) => view.messages),
      );

      yield* Atom.set(atoms.open, undefined);
      yield* done(atoms.open);
      yield* Atom.set(atoms.send, { content: "hi" });
      yield* done(atoms.send);
      const answered = yield* shown;
      expect(Option.map(answered, (messages) => messages.map(({ role }) => role))).toEqual(
        Option.some(["user", "assistant"]),
      );

      yield* Atom.mount(atoms.notTaken);
      const again = { content: "" };
      yield* Atom.set(atoms.send, again);
      expect(yield* Effect.flip(done(atoms.send))).toMatchObject({ error: "empty_message" });
      expect(yield* shown).toEqual(answered);
      const notTaken = Option.getOrThrow(yield* Atom.get(atoms.notTaken));
      expect(notTaken.input).toBe(again);
      expect(notTaken.refusal).toMatchObject({ error: "empty_message" });
    }).pipe(Effect.provideService(AtomRegistry.AtomRegistry, AtomRegistry.make()), Effect.scoped),
  );

  it.effect("a page reads a run another page started, once it hears of it", () =>
    Effect.gen(function* () {
      yield* selectTestModel();
      const session = yield* freshSession;
      const starting = (yield* pageSessions)(session);
      const reading = (yield* pageSessions)(session);
      const onReader = Effect.provideService(AtomRegistry.AtomRegistry, AtomRegistry.make());
      yield* onReader(
        Effect.gen(function* () {
          yield* Atom.set(reading.open, undefined);
          yield* done(reading.open);
          yield* Atom.set(reading.latest, null);
          yield* Atom.mount(reading.follow);
          yield* Atom.set(reading.follow, undefined);
        }),
      );

      yield* Atom.set(starting.send, { content: "hi" });
      yield* done(starting.send);
      const started = yield* (yield* agentChat).status(session, null);
      yield* onReader(Atom.set(reading.latest, started.lastRun?.runId ?? null));

      const roles = Atom.toStream(reading.state).pipe(
        Stream.map(
          Option.match({
            onNone: () => [],
            onSome: ({ view }) => view.messages.map(({ role }) => role),
          }),
        ),
        Stream.filter((shown) => shown.length === 2),
        Stream.runHead,
        Effect.timeout("5 seconds"),
      );
      expect(yield* onReader(roles)).toEqual(Option.some(["user", "assistant"]));
    }).pipe(Effect.provideService(AtomRegistry.AtomRegistry, AtomRegistry.make()), Effect.scoped),
  );

  it.effect(
    "an approval another page answered closes here, and a late answer to it is dropped",
    () =>
      Effect.gen(function* () {
        yield* selectTestModel();
        const session = yield* freshSession;
        const agent = yield* agentChat;
        const invocations = yield* invocationsOf(session);
        /** A page with its own registry, once it has read the conversation. */
        const openedPage = Effect.gen(function* () {
          const atoms = (yield* pageSessions)(session);
          const on = Effect.provideService(AtomRegistry.AtomRegistry, AtomRegistry.make());
          yield* on(
            Effect.gen(function* () {
              yield* Atom.mount(atoms.open);
              yield* Atom.set(atoms.open, undefined);
              yield* done(atoms.open);
            }),
          );
          const waiting = Effect.map(
            Atom.get(atoms.state),
            Option.flatMapNullishOr(({ view }) => view.interrupts),
          );
          /** The page's view once it shows no approval, within five seconds. */
          const closed = Atom.toStream(atoms.state).pipe(
            Stream.filter(Option.exists(({ view }) => view.interrupts === null)),
            Stream.runHead,
            Effect.timeout("5 seconds"),
          );
          return { atoms, on, waiting: on(waiting), closed: on(closed) };
        });

        const first = yield* openedPage;
        yield* first.on(Atom.set(first.atoms.send, { content: "please use the shell" }));
        yield* first.on(done(first.atoms.send));
        const interrupts = Option.getOrThrow(yield* first.waiting);
        expect(interrupts.pending).toHaveLength(1);

        const second = yield* openedPage;
        const third = yield* openedPage;
        expect(Option.getOrThrow(yield* second.waiting).pending).toHaveLength(1);
        expect(Option.getOrThrow(yield* third.waiting).pending).toHaveLength(1);
        // Only the third page hears of the server's runs.
        const before = yield* agent.status(session, null);
        yield* third.on(
          Effect.gen(function* () {
            yield* Atom.set(third.atoms.latest, (before.running ?? before.lastRun)?.runId ?? null);
            yield* Atom.mount(third.atoms.follow);
            yield* Atom.set(third.atoms.follow, undefined);
          }),
        );

        const answers = interrupts.pending.map(({ id }) => ({
          interruptId: id,
          status: "resolved" as const,
          payload: { approved: true },
        }));
        yield* second.on(
          Atom.set(second.atoms.answer, {
            parentRunId: interrupts.runId,
            answers,
          }),
        );
        yield* second.on(done(second.atoms.answer));
        const answered = (yield* agent.status(session, null)).lastRun?.runId ?? null;
        const calls = invocations().length;

        // The third page hears of the run the answer started and reads the conversation again.
        yield* third.on(Atom.set(third.atoms.latest, answered));
        expect(Option.isSome(yield* third.closed)).toBe(true);

        // The first page has not heard of it; its late answer is dropped without a failure.
        yield* first.on(
          Atom.set(first.atoms.answer, {
            parentRunId: interrupts.runId,
            answers,
          }),
        );
        yield* first.on(done(first.atoms.answer));
        expect(Option.isSome(yield* first.closed)).toBe(true);
        expect(invocations()).toHaveLength(calls);
      }).pipe(Effect.scoped),
  );
});
