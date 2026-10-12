import { Cause, Effect } from "effect";
import { Database, Nodes } from "memory-agent";
import { expect } from "vite-plus/test";
import { randomUUID } from "../../../../packages/memory-agent/src/runtime/synchronous-crypto.ts";
import { selectTestModel } from "../../../../packages/memory-agent/tests/support/provider.ts";
import {
  TestEnv,
  testAgent,
  type AgentServices,
} from "../../../../packages/memory-agent/tests/support/test-env.ts";
import { makeBtwHandlers } from "../../app/.server/btw-handlers";

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
const question = (text: string) =>
  JSON.stringify({
    threadId: "page",
    runId: `run-${randomUUID()}`,
    messages: [{ id: randomUUID(), role: "user", content: text }],
    tools: [],
    context: [],
  });

testAgent({
  testProvider: {
    responder: (invocation) =>
      invocation.messages.at(-1)?.role === "tool"
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
      const { sqlite } = yield* Database;
      const session = env.session.id;
      const mainNode = (text: string) =>
        nodes.append({ projectId: env.project.id, sessionId: session, kind: "user", text });
      mainNode("first main message");

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

      const ask = (text: string) =>
        call(() =>
          routes.chat({
            request: local(`/api/btw/${thread}/chat`, { method: "POST", body: question(text) }),
            params: { thread },
          }),
        );
      const answer = (text: string) =>
        Effect.flatMap(ask(text), (response) => sdk(() => response.text()));
      expect(yield* answer("side question one")).toContain("BTW answer");
      mainNode("second main message, written after the BTW opened");
      expect(yield* answer("side question two")).toContain("BTW answer");
      const latest = env.provider!.adapter.invocations.at(-2)!;
      expect(latest.systemPrompts.join("\n")).toContain("second main message");
      expect(nodes.session(session).map((node) => node.text)).toEqual([
        "first main message",
        "second main message, written after the BTW opened",
      ]);

      const listed = yield* call(() => routes.list({ params: { session } }));
      expect(yield* sdk(() => listed.json())).toMatchObject([
        { id: thread, title: "side question one" },
      ]);
      const reopened = yield* call(() =>
        routes.hydrate({
          request: local(`/api/btw/${thread}/chat?threadId=${thread}`),
          params: { thread },
        }),
      );
      const transcript = yield* sdk(() => reopened.text());
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
      expect(
        sqlite.prepare("SELECT count(*) AS n FROM btw_threads WHERE id = ?").get(thread),
      ).toEqual({ n: 0 });
      expect((yield* remove()).status).toBe(404);
      expect((yield* ask("after delete")).status).toBe(404);
    }),
  );
});
