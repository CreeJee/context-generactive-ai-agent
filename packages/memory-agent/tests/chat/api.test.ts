import { Effect, Layer, Stream } from "effect";
import { HttpServer } from "effect/http";
import { HttpApiTest } from "effect/http-api";
import { expect } from "vite-plus/test";
import { AgentChat } from "../../src/agent/chat.ts";
import { ChatApi, SameSite } from "../../src/api/chat-api.ts";
import { ChatApiHandlers } from "../../src/api/chat-api-live.ts";
import { selectTestModel } from "../support/provider.ts";
import { testAgent } from "../support/test-env.ts";
import { agentChat, freshSession } from "./tab.ts";

// The app checks the request's Origin; these requests come from the test itself.
const sameSite = Layer.succeed(SameSite, (httpEffect) => httpEffect);

/** A typed client of the chat API, answered in-process by the open agent. */
const chatApi = Effect.gen(function* () {
  const handlers = yield* Layer.build(
    ChatApiHandlers.pipe(
      Layer.provide(Layer.succeed(AgentChat, yield* agentChat)),
      Layer.provideMerge(sameSite),
      Layer.merge(HttpServer.layerServices),
    ),
  );
  return (yield* HttpApiTest.groups(ChatApi, ["chat"]).pipe(Effect.provideContext(handlers))).chat;
});

const message = (content: string) => ({ id: "m-1", role: "user" as const, content });

testAgent({ testProvider: {} })("chat API", (it) => {
  it.effect("a run's event ids are offsets a join resumes after", () =>
    Effect.gen(function* () {
      yield* selectTestModel();
      const session = yield* freshSession;
      const api = yield* chatApi;
      const run = `${session}-api`;

      const events = yield* api
        .run({
          params: { session },
          headers: {},
          payload: { runId: run, messages: [message("hi")] },
        })
        .pipe(Effect.flatMap(Stream.runCollect));
      expect(events.map((event) => event.data.type)).toEqual(
        expect.arrayContaining(["CUSTOM", "RUN_STARTED", "RUN_FINISHED"]),
      );
      expect(events.at(-1)?.data.type).toBe("RUN_FINISHED");

      const rest = yield* api
        .join({ params: { session, run }, query: { after: events[1]!.id } })
        .pipe(Effect.flatMap(Stream.runCollect));
      expect(rest).toEqual(events.slice(2));
    }),
  );

  it.effect("refusals keep their codes", () =>
    Effect.gen(function* () {
      yield* selectTestModel();
      const session = yield* freshSession;
      const api = yield* chatApi;
      const run = `${session}-api`;

      const unknownRun = yield* api
        .join({ params: { session, run }, query: {} })
        .pipe(Effect.flatMap(Stream.runCollect), Effect.flip);
      expect(unknownRun).toMatchObject({ error: "run_not_found" });

      yield* (yield* agentChat).lease(session, "tab-a", "claim");
      const held = yield* api
        .run({
          params: { session },
          headers: { "x-session-holder": "tab-b" },
          payload: { runId: run, messages: [message("hi")] },
        })
        .pipe(Effect.flip);
      expect(held).toMatchObject({ error: "session_in_use" });

      yield* api
        .run({
          params: { session },
          headers: { "x-session-holder": "tab-a" },
          payload: { runId: run, messages: [message("hi")] },
        })
        .pipe(Effect.flatMap(Stream.runDrain));
      const badOffset = yield* api
        .join({ params: { session, run }, query: { after: "not-an-offset" } })
        .pipe(Effect.flatMap(Stream.runCollect), Effect.flip);
      expect(badOffset).toMatchObject({ error: "invalid_stream_offset" });
    }),
  );
});
