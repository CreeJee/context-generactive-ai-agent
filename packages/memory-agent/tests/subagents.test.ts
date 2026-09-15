import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { CodexAppServer } from "../src/codex/app-server.ts";
import { CodexModels } from "../src/codex/models.ts";
import { Database } from "../src/db/database.ts";
import { PermissionReviews } from "../src/permissions/reviews.ts";
import { Projects } from "../src/projects/projects.ts";
import { RelayedApprovals } from "../src/approvals/relayed.ts";
import { Subagents } from "../src/subagents/subagents.ts";
import { testRuntime } from "./support/runtime.ts";

const fakeServer = fileURLToPath(new URL("./support/fake-codex.mjs", import.meta.url));
const fakeCodex = CodexAppServer.withCommand({
  executable: process.execPath,
  args: [fakeServer, "--signed-in"],
});

async function until(condition: () => boolean, what: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const Delta = Schema.parseJson(
  Schema.Struct({ type: Schema.String, delta: Schema.optional(Schema.String) }),
);
const answerOf = (events: string) =>
  events
    .split("\n")
    .flatMap((line) =>
      line.startsWith("data: ") ? [Schema.decodeUnknownSync(Delta)(line.slice(6))] : [],
    )
    .flatMap((event) => (event.type === "TEXT_MESSAGE_CONTENT" && event.delta ? [event.delta] : []))
    .join("");

const ThreadStarts = Schema.Struct({
  log: Schema.Array(
    Schema.Struct({
      method: Schema.String,
      params: Schema.optional(
        Schema.Struct({
          baseInstructions: Schema.optional(Schema.String),
          dynamicTools: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
        }),
      ),
    }),
  ),
});

async function subagentSetup(mode: "ask" | "auto" = "ask") {
  const context = await testRuntime({ codex: fakeCodex });
  await context.runtime.runPromise(
    Effect.gen(function* () {
      yield* (yield* CodexModels).select("fast-1");
      yield* (yield* Projects).setPermissionMode(context.project.id, mode);
    }),
  );
  const subagents = await context.runtime.runPromise(Subagents);
  const relayed = await context.runtime.runPromise(RelayedApprovals);
  const state = () => ({
    subagents: subagents.list(context.session.id),
    approvals: relayed.pending(context.session.id),
  });
  /** Starts a run; its events are read in the background until it ends. */
  const send = async (text: string) => {
    const response = await context.runtime.runPromise(
      Effect.flatMap(AgentChat, (agent) =>
        agent.handle(
          new Request("http://127.0.0.1/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              threadId: context.session.id,
              runId: `run-${Math.random().toString(36).slice(2)}`,
              messages: [{ id: "m1", role: "user", content: text }],
              tools: [],
              context: [],
            }),
          }),
          context.session.id,
        ),
      ),
    );
    return response.text().then(answerOf);
  };
  const threadStarts = () =>
    context.runtime.runPromise(
      Effect.flatMap(CodexAppServer, (codex) => codex.request("test/log", {}, ThreadStarts)),
    );
  return { ...context, subagents, relayed, state, send, threadStarts };
}

describe("subagents", () => {
  test("a one-off child gets only the task, the parent's tools minus subagents, and reports back", async () => {
    const { send, subagents, session, state, threadStarts } = await subagentSetup();

    const answer = await send('call run_subagent {"task":"list what matters"}');
    expect(answer).toContain("child done: list what matters (earlier user messages: 0)");
    expect(answer).toContain('"status":"completed"');

    const [child] = state().subagents;
    expect(child).toMatchObject({ name: null, status: "completed", lastTask: "list what matters" });

    const starts = (await threadStarts()).log.filter((entry) => entry.method === "thread/start");
    const childStart = starts.find((entry) =>
      entry.params?.baseInstructions?.includes("You are a subagent"),
    );
    const parentStart = starts.find((entry) =>
      entry.params?.baseInstructions?.includes("You can delegate with run_subagent"),
    );
    const names = (entry: typeof childStart) =>
      entry?.params?.dynamicTools?.map((tool) => tool.name) ?? [];
    expect(names(parentStart)).toContain("run_subagent");
    // No nesting, and nothing the parent does not have.
    expect(names(childStart)).not.toContain("run_subagent");
    expect(names(childStart)).not.toContain("message_subagent");
    expect(names(childStart).every((name) => names(parentStart).includes(name))).toBe(true);
    // The parent's conversation is not copied into the child.
    expect(childStart?.params?.baseInstructions).not.toContain("call run_subagent");

    const transcript = await subagents.transcript(session.id, child!.id);
    expect(transcript?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  test("subagent calls of one step run at the same time and answer in call order", async () => {
    const { send, state } = await subagentSetup();

    const started = Date.now();
    const answer = await send("delegate twice");
    const elapsed = Date.now() - started;
    expect(answer.indexOf("napped: nap A")).toBeGreaterThan(-1);
    expect(answer.indexOf("napped: nap A")).toBeLessThan(answer.indexOf("napped: nap B"));
    // Each child naps 700ms; one after another would take at least 1400ms.
    expect(elapsed).toBeLessThan(1350);
    expect(state().subagents.map((child) => child.status)).toEqual(["completed", "completed"]);
  });

  test("a named child keeps its own conversation across the session's runs", async () => {
    const { send, state } = await subagentSetup();

    await send('call message_subagent {"agent":"helper","message":"first task"}');
    const second = await send('call message_subagent {"agent":"helper","message":"second task"}');
    expect(second).toContain("child done: second task (earlier user messages: 1)");
    const children = state().subagents;
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ name: "helper", lastTask: "second task" });
  });

  test("a child's gated call waits for the user on the page, and a denial never runs it", async () => {
    const { send, relayed, session, state, runtime } = await subagentSetup("ask");

    const approved = send('call run_subagent {"task":"shell: printf child-approved"}');
    await until(() => state().approvals.length === 1, "the child's approval");
    const [request] = state().approvals;
    expect(request).toMatchObject({
      toolName: "run_shell",
      askedBy: "every_call",
      requester: { kind: "subagent", name: null },
    });
    expect(relayed.answer("another-session", request!.id, true)).toBe(false);
    expect(relayed.answer(session.id, request!.id, true)).toBe(true);
    const approvedAnswer = await approved;
    expect(approvedAnswer).toContain("child-approved");
    expect(approvedAnswer).toContain("exitCode");

    const denied = send('call run_subagent {"task":"shell: printf child-denied"}');
    await until(() => state().approvals.length === 1, "the second approval");
    relayed.answer(session.id, state().approvals[0]!.id, false);
    const deniedAnswer = await denied;
    expect(deniedAnswer).toContain("User denied this action");
    expect(deniedAnswer).not.toContain("exitCode");

    const reviews = await runtime.runPromise(PermissionReviews);
    const children = state().subagents;
    expect(reviews.latest(session.id, `subagent-${children[0]!.id}:call-shell`)?.decision).toBe(
      "approved",
    );
    expect(reviews.latest(session.id, `subagent-${children[1]!.id}:call-shell`)?.decision).toBe(
      "denied",
    );
  });

  test("cancelling the parent stops a waiting child, and a restart never reruns one", async () => {
    const { send, session, state, runtime, reopen } = await subagentSetup("ask");

    const run = send('call run_subagent {"task":"shell: printf never-runs"}');
    await until(() => state().approvals.length === 1, "the child's approval");
    const cancel = await runtime.runPromise(
      Effect.flatMap(AgentChat, (agent) => agent.cancel(session.id, null)),
    );
    expect(cancel.status).toBe(200);
    await run;
    await until(() => state().subagents[0]?.status === "cancelled", "the child to stop");
    expect(state().approvals).toEqual([]);

    // A child left running by a crash is marked interrupted when the server starts again.
    const db = await runtime.runPromise(Database);
    db.sqlite.prepare("UPDATE subagents SET status = 'running'").run();
    const reopened = await reopen();
    const after = await reopened.runPromise(Effect.map(Subagents, (s) => s.list(session.id)));
    expect(after[0]?.status).toBe("interrupted");
  });
});
