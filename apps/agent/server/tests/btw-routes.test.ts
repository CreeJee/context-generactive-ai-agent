import { Cause, Effect, Stream } from "effect";
import { Nodes } from "memory-agent";
import { AgUiEvent } from "../../../../packages/memory-agent/src/loop/chunks.ts";
import { expect } from "vite-plus/test";
import { randomUUID } from "../../../../packages/memory-agent/src/runtime/synchronous-crypto.ts";
import { btwApi } from "../../../../packages/memory-agent/tests/support/chat-api.ts";
import { selectTestModel } from "../../../../packages/memory-agent/tests/support/provider.ts";
import {
  TestEnv,
  testAgent,
  type AgentServices,
} from "../../../../packages/memory-agent/tests/support/test-env.ts";
import { makeBtwHandlers } from "../../app/.server/btw-handlers";
import { sqlGet } from "../../../../packages/memory-agent/tests/support/sql.ts";

const sdk = <A>(operation: () => A | PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
const local = (url: string, init: RequestInit = {}) =>
  new Request(`http://localhost${url}`, {
    ...init,
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
  });
const question = (text: string) => ({
  runId: `run-${randomUUID()}`,
  message: { id: randomUUID(), role: "user" as const, content: text },
});

testAgent({
  testProvider: {
    responder: (invocation) =>
      invocation.history.at(-1)?.role === "tool"
        ? { text: "BTW answer" }
        : {
            toolCalls: [
              { id: `find-${invocation.index}`, name: "find_memory", arguments: '{"query":"x"}' },
            ],
          },
  },
})("BTW routes", (it) => {
  it.effect("open, answer from the latest main conversation, reopen and delete", () =>
    Effect.gen(function* () {
      yield* selectTestModel();
      const env = yield* TestEnv;
      const runPromise = Effect.runPromiseWith(yield* Effect.context<AgentServices>());
      const routes = makeBtwHandlers({ runPromise });
      const call = (route: () => Promise<Response>) => sdk(route);
      const nodes = yield* Nodes;
      const session = env.session.id;
      const mainNode = (text: string) =>
        nodes.append({ projectId: env.project.id, sessionId: session, kind: "user", text });
      yield* mainNode("first main message");

      const missingParent = yield* call(() =>
        routes.create({
          request: local("/api/sessions/none/btw", { method: "POST" }),
          params: { session: "none" },
        }),
      );
      expect(missingParent.status).toBe(404);
      const created = yield* call(() =>
        routes.create({
          request: local(`/api/sessions/${session}/btw`, { method: "POST" }),
          params: { session },
        }),
      );
      expect(created.status).toBe(201);
      const { id: thread } = yield* sdk(() => created.json());

      const btw = yield* btwApi;
      const ask = (text: string) => btw.ask({ params: { thread }, payload: question(text) });
      const answer = (text: string) =>
        Effect.flatMap(ask(text), (events) =>
          Stream.runFold(
            events,
            () => "",
            (text, { data }) =>
              AgUiEvent.guards.TEXT_MESSAGE_CONTENT(data) ? text + data.delta : text,
          ),
        );
      expect(yield* answer("side question one")).toContain("BTW answer");
      yield* mainNode("second main message, written after the BTW opened");
      expect(yield* answer("side question two")).toContain("BTW answer");
      const latest = env.provider!.invocations.at(-2)!;
      expect(latest.system.join("\n")).toContain("second main message");
      expect((yield* nodes.session(session)).map((node) => node.text)).toEqual([
        "first main message",
        "second main message, written after the BTW opened",
      ]);

      const listed = yield* call(() => routes.list({ params: { session } }));
      expect(yield* sdk(() => listed.json())).toMatchObject([
        { id: thread, title: "side question one" },
      ]);
      const transcript = JSON.stringify(yield* btw.messages({ params: { thread } }));
      expect(transcript).toContain("side question two");
      expect(transcript).toContain("find_memory");

      const foreign = new Request(`http://localhost/api/btw/${thread}`, {
        method: "DELETE",
        headers: { Origin: "http://evil.example" },
      });
      expect(
        (yield* call(() => routes.remove({ request: foreign, params: { thread } }))).status,
      ).toBe(403);
      const remove = () =>
        call(() =>
          routes.remove({
            request: local(`/api/btw/${thread}`, { method: "DELETE" }),
            params: { thread },
          }),
        );
      const deleted = yield* remove();
      expect(yield* sdk(() => deleted.json())).toEqual({ deleted: true, filesPending: false });
      expect(yield* sqlGet("SELECT count(*) AS n FROM btw_threads WHERE id = ?", thread)).toEqual({
        n: 0,
      });
      expect((yield* remove()).status).toBe(404);
      expect(yield* Effect.flip(ask("after delete"))).toEqual({ error: "btw_not_found" });
    }),
  );
});
