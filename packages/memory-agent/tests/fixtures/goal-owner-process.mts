import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { Effect, ManagedRuntime, Schema } from "effect";
import { memoryAgentLayer, Projects, Sessions } from "../../src/index.ts";
import { AgentChat } from "../../src/agent/chat.ts";
import { Database } from "../../src/db/database.ts";
import { SecretStore } from "../../src/config/secrets.ts";
import { fakeEmbedderLayer } from "../../src/testing/fake-embedder.ts";
import { fakeMorphLayer } from "../../src/testing/fake-morph.ts";
import { Workflows } from "../../src/workflow/workflow.ts";
import { testProvider, turnGate } from "../support/provider.ts";

const [base, mode] = process.argv.slice(2);
if (!base) throw new Error("Missing owned temporary root");
process.env.CONTEXT_AGENT_GOAL_WORKER = "1";
const gate = turnGate();
const provider = testProvider({
  responder: () => {
    appendFileSync(join(base, "model-calls"), `${process.pid}\n`);
    return mode === "blocked"
      ? { text: "never completed", waitFor: gate.waitFor }
      : { text: "completed owner turn" };
  },
});
// Preserve the original adapter instance, capabilities and methods; only wrap
// its stream in this owned subprocess to hold the terminal behind a text chunk.
if (mode === "partial") {
  const original = provider.adapter.chatStream.bind(provider.adapter);
  provider.adapter.chatStream = async function* (...args) {
    for await (const chunk of original(...args)) {
      yield chunk;
      if (chunk.type === "TEXT_MESSAGE_CONTENT") await gate.waitFor;
    }
  };
}
const home = join(base, "home");
mkdirSync(home, { recursive: true });
const runtime = ManagedRuntime.make(
  memoryAgentLayer(join(base, "storage"), {
    embedder: fakeEmbedderLayer,
    morphAnalyzer: fakeMorphLayer,
    interpretAutomatically: false,
    summarizeAutomatically: false,
    secrets: SecretStore.memory,
    skillsHome: home,
    skillsBuiltin: join(base, "builtin"),
    importsHome: home,
    importsWatching: false,
    sweepSecrets: false,
    providerRegistry: provider.layer,
  }),
);
await provider.select(runtime);
const { chat, db, workflows } = await runtime.runPromise(
  Effect.all({ chat: AgentChat, db: Database, workflows: Workflows }),
);
let sessionId: string;
if (mode === "reopen") sessionId = readFileSync(join(base, "session"), "utf8");
else {
  mkdirSync(join(base, "project"), { recursive: true });
  sessionId = await runtime.runPromise(
    Effect.gen(function* () {
      const project = yield* (yield* Projects).add(join(base, "project"));
      return (yield* (yield* Sessions).create(project.id)).id;
    }),
  );
  writeFileSync(join(base, "session"), sessionId);
  await runtime.runPromise(
    workflows.updateGoal(sessionId, {
      statement: "Preserve OS owner evidence",
      outcomes: ["Never replay interrupted model work"],
      constraints: [],
      nonGoals: [],
      assumptions: [],
      openQuestions: [],
      status: "active",
    }),
  );
}
// Test-only loopback adapter; this is not the application's authentication route.
const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/inspect") {
      outgoing.setHeader("Content-Type", "application/json");
      outgoing.end(
        JSON.stringify({
          runs: db.sqlite.prepare("SELECT * FROM chat_runs ORDER BY started_at").all(),
          bindings: db.sqlite.prepare("SELECT * FROM workflow_run_bindings").all(),
          operations: db.sqlite.prepare("SELECT * FROM owner_rpc_operations").all(),
          revisions: db.sqlite.prepare("SELECT * FROM workflow_state_revisions").all(),
          dispatches: db.sqlite.prepare("SELECT * FROM workflow_worker_dispatches").all(),
        }),
      );
      return;
    }
    const parts: Buffer[] = [];
    for await (const part of incoming) parts.push(Buffer.from(part));
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
    }
    const request = new Request(
      url,
      incoming.method === "POST"
        ? { method: "POST", headers, body: Buffer.concat(parts).toString() }
        : { headers },
    );
    const response = await runtime.runPromise(
      incoming.method === "POST"
        ? chat.handle(request, sessionId)
        : chat.hydrate(request, sessionId),
    );
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        outgoing.write(chunk.value);
      }
    }
    outgoing.end();
  } catch (error) {
    outgoing.writeHead(500);
    outgoing.end(String(error));
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }))(address);
process.send?.({ type: "ready", port, sessionId, pid: process.pid });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  gate.release();
  server.closeAllConnections();
  server.close();
  await runtime.dispose();
  process.exit(0);
}
process.on("SIGTERM", () => {
  void stop();
});
process.on("disconnect", () => {
  void stop();
});
setTimeout(() => {
  void stop();
}, 45_000).unref();
