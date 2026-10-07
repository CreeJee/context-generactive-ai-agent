import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";
import { Cause, Effect, Option, Result, Schedule, Schema } from "effect";
import { it } from "@effect/vitest";
import { selectTestModel } from "./support/provider.ts";
import { describe, expect } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { Indexer } from "../src/memory/embedding/indexer.ts";
import { MemorySearch } from "../src/memory/search.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { approvalToolDefinitions } from "../src/tools/definitions.ts";
import { turnGate } from "./support/provider.ts";
import { testRuntime } from "./support/runtime.ts";

const Archived = Schema.Struct({ id: Schema.String, archivedAt: Schema.NullOr(Schema.String) });
const Running = Schema.Struct({ running: Schema.NullOr(Schema.Struct({ runId: Schema.String })) });

const until = Effect.fn("archive.until")(
  <E, R>(condition: Effect.Effect<boolean, E, R>, what: string) =>
    condition.pipe(
      Effect.repeat({ until: (ready) => ready, schedule: Schedule.spaced(20) }),
      Effect.timeoutOption(6_000),
      Effect.tap((ready) => Effect.sync(() => expect(Option.isSome(ready), what).toBe(true))),
    ),
);

describe("archived conversations", () => {
  it.live("leave the session list but stay in memory, and come back when restored", () =>
    Effect.gen(function* () {
      const { runtime, project, session } = yield* Effect.tryPromise({
        try: () => testRuntime(),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      const result = yield* Effect.provideContext(
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const kept = yield* sessions.create(project.id, "kept");
          const node = (yield* Nodes).append({
            projectId: project.id,
            sessionId: session.id,
            kind: "user",
            text: "배포는 화요일에만 하기로 했다",
          });
          yield* (yield* Indexer).indexAll();

          const archived = yield* sessions.setArchived(session.id, true);
          const listed = yield* sessions.list(project.id);
          const inArchive = yield* sessions.list(project.id, true);
          const found = yield* (yield* MemorySearch).find({
            query: "배포 요일",
            projectId: project.id,
          });
          const restored = yield* sessions.setArchived(session.id, false);
          const afterRestore = yield* sessions.list(project.id);
          const missing = yield* Effect.result(sessions.setArchived("no-such-session", true));
          return {
            kept,
            node,
            archived,
            listed,
            inArchive,
            found,
            restored,
            afterRestore,
            missing,
          };
        }),
        yield* runtime.contextEffect,
      );

      expect(result.archived.archivedAt).not.toBeNull();
      expect(result.listed.map((item) => item.id)).toEqual([result.kept.id]);
      expect(result.inArchive.map((item) => item.id)).toEqual([session.id]);
      expect(result.found.matches.map((match) => match.id)).toContain(result.node.id);
      expect(result.restored.archivedAt).toBeNull();
      expect(result.afterRestore.map((item) => item.id).sort()).toEqual(
        [result.kept.id, session.id].sort(),
      );
      expect(Result.isFailure(result.missing) && result.missing.failure._tag).toBe(
        "SessionNotFound",
      );
    }),
  );

  it.live("respect another page's lease and safely stop a running answer before archive", () =>
    Effect.gen(function* () {
      const gate = turnGate();
      const context = yield* Effect.tryPromise({
        try: () => testRuntime({ testProvider: { delayedTurnGate: gate.waitFor } }),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      const { runtime, session } = context;
      yield* Effect.provideContext(selectTestModel(), yield* runtime.contextEffect);
      const agent = yield* Effect.provideContext(AgentChat, yield* runtime.contextEffect);
      const archive = (holder: string | null, archived = true) =>
        agent.archive(session.id, holder, archived);

      yield* Effect.provideContext(
        agent.lease(session.id, "tab-a", "claim"),
        yield* runtime.contextEffect,
      );
      expect((yield* archive("tab-b")).status).toBe(423);

      const client = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new ChatClient({
              threadId: session.id,
              persistence: true,
              tools: approvalToolDefinitions,
              connection: fetchServerSentEvents(`http://127.0.0.1/api/chat?session=${session.id}`, {
                headers: { "X-Session-Holder": "tab-a" },
                fetchClient: (input, init) =>
                  runtime.runPromise(
                    (init?.method ?? "GET") === "POST"
                      ? agent.handle(new Request(input, init), session.id)
                      : agent.hydrate(new Request(input, init), session.id),
                  ),
              }),
            }),
        ),
        (client) => Effect.sync(() => client.dispose()),
      );
      client.attach();
      void client.sendMessage("please be slow");
      const running = Effect.fnUntraced(function* () {
        const response = yield* agent.status(session.id, "tab-a");
        const status = yield* Schema.decodeUnknownEffect(Running)(
          yield* Effect.tryPromise({
            try: () => response.json(),
            catch: (cause) => new Cause.UnknownError(cause),
          }),
        );
        return status.running !== null;
      });
      yield* until(running(), "the run to start");
      const done = yield* archive("tab-a");
      expect(done.status).toBe(200);
      yield* until(running().pipe(Effect.map((value) => !value)), "the run to stop");
      client.dispose();

      expect(
        (yield* Schema.decodeUnknownEffect(Archived)(
          yield* Effect.tryPromise({
            try: () => done.json(),
            catch: (cause) => new Cause.UnknownError(cause),
          }),
        )).archivedAt,
      ).not.toBeNull();
      const back = yield* archive("tab-a", false);
      expect(
        (yield* Schema.decodeUnknownEffect(Archived)(
          yield* Effect.tryPromise({
            try: () => back.json(),
            catch: (cause) => new Cause.UnknownError(cause),
          }),
        )).archivedAt,
      ).toBeNull();
    }),
  );
});
