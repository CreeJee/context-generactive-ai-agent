import { it } from "@effect/vitest";
import { Cause, ConfigProvider, Context, Effect, Layer, Schema } from "effect";
import { expect } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { Database } from "../src/db/database.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";

it.live(
  "real AgentChat workers link two Goal runs to separate native registrations and cold revalidate",
  () =>
    Effect.gen(function* () {
      const flags = yield* Layer.build(
        ConfigProvider.layerAdd(
          ConfigProvider.fromUnknown({
            CONTEXT_AGENT_NATIVE_ARTIFACT: "1",
            CONTEXT_AGENT_GOAL_WORKER: "1",
          }),
          { asPrimary: true },
        ),
      );
      const context = yield* sdkCall(() =>
        testRuntime({
          testProvider: { responder: () => ({ text: "native registered answer" }) },
        }),
      );
      let runtime = context.runtime;
      yield* Effect.addFinalizer(() => sdkCall(() => runtime.dispose()).pipe(Effect.orDie));
      yield* sdkCall(() => context.provider!.select(runtime));
      const owner = yield* Effect.provideContext(
        Effect.all({ db: Database, sessions: Sessions, workflows: Workflows }),
        yield* runtime.contextEffect,
      );
      const b = yield* Effect.provideContext(
        owner.sessions.create(context.project.id),
        yield* runtime.contextEffect,
      );
      for (const session of [context.session.id, b.id])
        yield* Effect.provideContext(
          owner.workflows.updateGoal(session, {
            statement: "Native execution provenance",
            outcomes: ["Preserve registered factory code"],
            constraints: [],
            nonGoals: [],
            assumptions: [],
            openQuestions: [],
            status: "active",
          }),
          yield* runtime.contextEffect,
        );
      const send = Effect.fn("NativeRegistrationTest.send")(function* (
        session: string,
        run: string,
      ) {
        const services = Context.merge(yield* runtime.contextEffect, flags);
        const request = new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            threadId: session,
            runId: run,
            messages: [{ id: run, role: "user", content: "hello" }],
            tools: [],
            context: [],
          }),
        });
        const response = yield* Effect.provideContext(
          Effect.flatMap(AgentChat, (chat) => chat.handle(request, session)),
          services,
        );
        expect(response.status).toBe(200);
        const text = yield* sdkCall(() => response.text());
        expect(text).not.toContain("RUN_ERROR");
        expect(text).toContain("native registered answer");
      });
      yield* send(context.session.id, "native-a");
      yield* send(b.id, "native-b");
      const provenance = Effect.fn("NativeRegistrationTest.provenance")(function* (
        db: Database["Service"],
      ) {
        return yield* Schema.decodeUnknownEffect(
          Schema.Array(
            Schema.Struct({
              run_id: Schema.String,
              goal_instance_id: Schema.String,
              artifact_url: Schema.String,
              artifact_hash: Schema.String,
            }),
          ),
        )(
          db.sqlite
            .prepare(`SELECT b.run_id, b.goal_instance_id, a.artifact_url, a.artifact_hash
      FROM workflow_run_bindings b JOIN workflow_goal_native_artifacts a USING(goal_instance_id)
      WHERE b.run_id IN ('native-a', 'native-b') ORDER BY b.run_id`)
            .all(),
        );
      });
      const before = yield* provenance(owner.db);
      expect(before).toHaveLength(2);
      expect(before[0]!.goal_instance_id).not.toBe(before[1]!.goal_instance_id);
      expect(before[0]!.artifact_url).not.toBe(before[1]!.artifact_url);
      runtime = yield* sdkCall(() => context.reopen());
      yield* send(context.session.id, "native-a-reopened");
      expect(
        yield* provenance(yield* Effect.provideContext(Database, yield* runtime.contextEffect)),
      ).toEqual(before);
    }),
  60000,
);

const sdkCall = Effect.fn("NativeRegistrationTest.sdkCall")(<A>(call: () => A | PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);
