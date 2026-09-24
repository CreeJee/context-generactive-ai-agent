import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";
import { Effect, Result, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { Indexer } from "../src/memory/embedding/indexer.ts";
import { MemorySearch } from "../src/memory/search.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { approvalToolDefinitions } from "../src/tools/definitions.ts";
import { testRuntime } from "./support/runtime.ts";

const Archived = Schema.Struct({ id: Schema.String, archivedAt: Schema.NullOr(Schema.String) });
const Running = Schema.Struct({ running: Schema.NullOr(Schema.Struct({ runId: Schema.String })) });

async function until(condition: () => boolean | Promise<boolean>, what: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("archived conversations", () => {
  test("leave the session list but stay in memory, and come back when restored", async () => {
    const { runtime, project, session } = await testRuntime();
    const result = await runtime.runPromise(
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
        return { kept, node, archived, listed, inArchive, found, restored, afterRestore, missing };
      }),
    );

    expect(result.archived.archivedAt).not.toBeNull();
    expect(result.listed.map((item) => item.id)).toEqual([result.kept.id]);
    expect(result.inArchive.map((item) => item.id)).toEqual([session.id]);
    expect(result.found.matches.map((match) => match.id)).toContain(result.node.id);
    expect(result.restored.archivedAt).toBeNull();
    expect(result.afterRestore.map((item) => item.id).sort()).toEqual(
      [result.kept.id, session.id].sort(),
    );
    expect(Result.isFailure(result.missing) && result.missing.failure._tag).toBe("SessionNotFound");
  });

  test("respect another page's lease and safely stop a running answer before archive", async () => {
    const context = await testRuntime({ testProvider: {} });
    const { runtime, session } = context;
    await context.provider!.select(runtime);
    const agent = await runtime.runPromise(AgentChat);
    const archive = (holder: string | null, archived = true) =>
      runtime.runPromise(agent.archive(session.id, holder, archived));

    await runtime.runPromise(agent.lease(session.id, "tab-a", "claim"));
    expect((await archive("tab-b")).status).toBe(423);

    const client = new ChatClient({
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
    });
    client.attach();
    void client.sendMessage("please be slow");
    const running = async () =>
      Schema.decodeUnknownSync(Running)(
        await (await runtime.runPromise(agent.status(session.id, "tab-a"))).json(),
      ).running !== null;
    await until(running, "the run to start");
    const done = await archive("tab-a");
    expect(done.status).toBe(200);
    await until(async () => !(await running()), "the run to stop");
    client.dispose();

    expect(Schema.decodeUnknownSync(Archived)(await done.json()).archivedAt).not.toBeNull();
    const back = await archive("tab-a", false);
    expect(Schema.decodeUnknownSync(Archived)(await back.json()).archivedAt).toBeNull();
  });
});
