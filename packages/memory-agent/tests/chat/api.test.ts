import { Effect, Stream } from "effect";
import { expect } from "vite-plus/test";
import type { RunEvent } from "../../src/api/chat-api.ts";
import { applyEvent, type ChatView, streamStarted, viewOf } from "../../src/api/chat-view.ts";
import { chatApi } from "../support/chat-api.ts";
import { selectTestModel } from "../support/provider.ts";
import { testAgent } from "../support/test-env.ts";
import { agentChat, freshSession } from "./tab.ts";

const message = (content: string, id = "m-1") => ({ id, role: "user" as const, content });

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

  it.effect("a snapshot pages the conversation and holds the approvals a run waits for", () =>
    Effect.gen(function* () {
      yield* selectTestModel();
      const session = yield* freshSession;
      const api = yield* chatApi;
      const send = (runId: string, text: string, id: string) =>
        api
          .run({
            params: { session },
            headers: {},
            payload: { runId, messages: [message(text, id)] },
          })
          .pipe(Effect.flatMap(Stream.runDrain));

      yield* send(`${session}-1`, "hi", "m-1");
      yield* send(`${session}-2`, "please use the shell", "m-2");
      const all = yield* api.snapshot({ params: { session }, query: { limit: 500 } });
      expect(all.older).toBeNull();
      expect(all.messages.filter((shown) => shown.role === "user")).toEqual([
        { id: "m-1", role: "user", parts: [{ type: "text", content: "hi" }] },
        { id: "m-2", role: "user", parts: [{ type: "text", content: "please use the shell" }] },
      ]);
      expect(all.interrupts).toMatchObject({ runId: `${session}-2` });
      // Parts the page does not show are left out; the call waiting for approval is kept.
      const waiting = all.interrupts?.pending[0];
      expect(waiting?.reason).toBe("tool_call");
      expect(all.messages.flatMap((shown) => shown.parts)).toContainEqual(
        expect.objectContaining({
          type: "tool-call",
          id: waiting?.reason === "tool_call" ? waiting.toolCallId : null,
        }),
      );

      const newest = yield* api.snapshot({ params: { session }, query: { limit: 2 } });
      expect(newest.messages).toEqual(all.messages.slice(-2));
      const older = yield* api.snapshot({
        params: { session },
        query: { limit: 500, before: newest.older! },
      });
      expect(older.messages).toEqual(all.messages.slice(0, -2));
      expect(older.older).toBeNull();
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

// The scripted model names its calls alike in every session, and an interrupt's id follows its
// call, so the test that answers an approval has an agent of its own.
testAgent({ testProvider: {} })("chat API view", (it) => {
  it.effect("a run's events build the messages the snapshot shows after it", () =>
    Effect.gen(function* () {
      yield* selectTestModel();
      const session = yield* freshSession;
      const api = yield* chatApi;
      const snapshot = api.snapshot({ params: { session }, query: { limit: 500 } });
      const read = <E>(events: Stream.Stream<RunEvent, E>, view: ChatView) =>
        Stream.runFold(
          events,
          () => view,
          (current, { data }) => applyEvent(current, data),
        );

      const asked = yield* read(
        yield* api.run({
          params: { session },
          headers: {},
          payload: { runId: `${session}-1`, messages: [message("please use the shell")] },
        }),
        viewOf({
          ...(yield* snapshot),
          messages: [
            { id: "m-1", role: "user", parts: [{ type: "text", content: "please use the shell" }] },
          ],
        }),
      );
      const waiting = yield* snapshot;
      expect(asked.messages).toEqual(waiting.messages);
      expect(asked.interrupts).toEqual(waiting.interrupts);

      const approved = yield* read(
        yield* api.run({
          params: { session },
          headers: {},
          payload: {
            runId: `${session}-2`,
            parentRunId: `${session}-1`,
            messages: [],
            resume: waiting.interrupts!.pending.map(({ id }) => ({
              interruptId: id,
              status: "resolved" as const,
              payload: { approved: true },
            })),
          },
        }),
        streamStarted(asked),
      );
      const answered = yield* snapshot;
      expect(approved.messages).toEqual(answered.messages);
      expect(approved.interrupts).toBeNull();

      // A page that rejoins reads the run from its start and writes its messages again.
      const rejoined = yield* read(
        yield* api.join({ params: { session, run: `${session}-2` }, query: {} }),
        viewOf(answered),
      );
      expect(rejoined.messages).toEqual(answered.messages);
    }),
  );
});
