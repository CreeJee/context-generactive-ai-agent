import { Effect, Schema } from "effect";
import { expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { Database } from "../src/db/database.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";

test("real AgentChat workers link two Goal runs to separate native registrations and cold revalidate", async () => {
  const previousNative = process.env.CONTEXT_AGENT_NATIVE_ARTIFACT;
  const previousWorker = process.env.CONTEXT_AGENT_GOAL_WORKER;
  process.env.CONTEXT_AGENT_NATIVE_ARTIFACT = "1";
  process.env.CONTEXT_AGENT_GOAL_WORKER = "1";
  const context = await testRuntime({
    testProvider: { responder: () => ({ text: "native registered answer" }) },
  });
  let runtime = context.runtime;
  try {
    await context.provider!.select(runtime);
    const owner = await runtime.runPromise(
      Effect.all({ db: Database, sessions: Sessions, workflows: Workflows }),
    );
    const b = await runtime.runPromise(owner.sessions.create(context.project.id));
    for (const session of [context.session.id, b.id])
      await runtime.runPromise(
        owner.workflows.updateGoal(session, {
          statement: "Native execution provenance",
          outcomes: ["Preserve registered factory code"],
          constraints: [],
          nonGoals: [],
          assumptions: [],
          openQuestions: [],
          status: "active",
        }),
      );
    const send = async (session: string, run: string) => {
      const response = await runtime.runPromise(
        Effect.flatMap(AgentChat, (chat) =>
          chat.handle(
            new Request("http://localhost/api/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                threadId: session,
                runId: run,
                messages: [{ id: run, role: "user", content: "hello" }],
                tools: [],
                context: [],
              }),
            }),
            session,
          ),
        ),
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain("RUN_ERROR");
      expect(text).toContain("native registered answer");
    };
    await send(context.session.id, "native-a");
    await send(b.id, "native-b");
    const provenance = (db: Database["Service"]) =>
      Schema.decodeUnknownSync(
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
    const before = provenance(owner.db);
    expect(before).toHaveLength(2);
    expect(before[0]!.goal_instance_id).not.toBe(before[1]!.goal_instance_id);
    expect(before[0]!.artifact_url).not.toBe(before[1]!.artifact_url);
    runtime = await context.reopen();
    await send(context.session.id, "native-a-reopened");
    expect(provenance(await runtime.runPromise(Database))).toEqual(before);
  } finally {
    await runtime.dispose();
    if (previousNative === undefined) delete process.env.CONTEXT_AGENT_NATIVE_ARTIFACT;
    else process.env.CONTEXT_AGENT_NATIVE_ARTIFACT = previousNative;
    if (previousWorker === undefined) delete process.env.CONTEXT_AGENT_GOAL_WORKER;
    else process.env.CONTEXT_AGENT_GOAL_WORKER = previousWorker;
  }
}, 60000);
