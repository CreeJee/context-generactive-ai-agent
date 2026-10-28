import { NodeCrypto } from "@effect/platform-node";
import { Effect, Layer, Option } from "effect";
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
import { agentChat, freshSession } from "./tab.ts";

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
  it.effect("a sent turn shows its run, and a refused turn leaves the conversation", () =>
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
      yield* Atom.set(atoms.send, { holder: "tab-a", content: "hi" });
      yield* done(atoms.send);
      const answered = yield* shown;
      expect(Option.map(answered, (messages) => messages.map(({ role }) => role))).toEqual(
        Option.some(["user", "assistant"]),
      );

      yield* (yield* agentChat).lease(session, "tab-b", "claim");
      yield* Atom.set(atoms.send, { holder: "tab-a", content: "again" });
      expect(yield* Effect.flip(done(atoms.send))).toMatchObject({ error: "session_in_use" });
      expect(yield* shown).toEqual(answered);
    }).pipe(Effect.provideService(AtomRegistry.AtomRegistry, AtomRegistry.make())),
  );
});
