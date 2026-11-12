import { layer } from "@effect/vitest";
import { Context, Effect, Layer, Scope } from "effect";
import { expect } from "vite-plus/test";
import { Nodes } from "../../src/memory/nodes.ts";
import { makeRecordingHook } from "../../src/memory/record.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { scriptedRun } from "../support/loop-run.ts";
import { TestEnv } from "../support/test-env.ts";

/** A second agent over its own storage, to check what is bound to which owner. */
class OtherAgent extends Context.Service<OtherAgent, TestEnv["Service"]>()(
  "memory-agent/tests/engine/memory-record.test/OtherAgent",
) {}

// Layers memoize by reference, so the second agent gets its own memo map; otherwise it would share
// the first agent's services.
const otherAgent = Layer.effect(
  OtherAgent,
  Effect.gen(function* () {
    const context = yield* Layer.buildWithMemoMap(
      TestEnv.layer(),
      yield* Layer.makeMemoMap,
      yield* Scope.Scope,
    );
    return Context.get(context, TestEnv);
  }),
);

layer(otherAgent.pipe(Layer.provideMerge(TestEnv.layer())), { excludeTestServices: true })(
  "Recorder",
  (it) => {
    it.effect("one recording hook reference uses each agent's current native owner context", () =>
      Effect.gen(function* () {
        const recordHello = Effect.fnUntraced(function* () {
          const { project } = yield* TestEnv;
          const session = yield* (yield* Sessions).create(project.id);
          const nodes = yield* Nodes;
          const user = yield* nodes.append({
            projectId: project.id,
            sessionId: session.id,
            kind: "user",
            text: "hello",
          });
          const runId = `${session.id}:run`;
          const hook = yield* makeRecordingHook({
            projectId: project.id,
            sessionId: session.id,
            runId,
            replyTo: Effect.succeedSome(user.id),
          });
          yield* scriptedRun({
            turns: [{ text: "owner answer" }],
            runId,
            conversation: [{ role: "user", content: "hello" }],
            hooks: [hook],
          });
          expect((yield* nodes.session(session.id)).map((node) => node.text)).toEqual([
            "hello",
            "owner answer",
          ]);
          return session.id;
        });
        yield* recordHello();
        const other = yield* OtherAgent;
        const otherSession = yield* other.use(
          recordHello().pipe(Effect.provideService(TestEnv, other)),
        );
        expect(yield* (yield* Nodes).session(otherSession)).toEqual([]);
      }),
    );
  },
);
