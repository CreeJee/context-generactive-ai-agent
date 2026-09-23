import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { ChatState } from "../src/chat-state/chat-state.ts";
import { Database } from "../src/db/database.ts";
import { messageText } from "../src/messages/text.ts";
import { Subagents } from "../src/subagents/subagents.ts";
import { WorkTraceStore } from "../src/work-trace/store.ts";
import { defaultTestResponder } from "./support/provider.ts";
import { testRuntime } from "./support/runtime.ts";

const Ids = Schema.Struct({ taskId: Schema.String, attemptId: Schema.String });
const Receipt = Schema.Struct({
  ...Ids.fields,
  status: Schema.Literal("running"),
  subagentId: Schema.String,
});
const Report = Schema.Struct({
  ...Ids.fields,
  status: Schema.String,
  answer: Schema.String,
  evidenceRefIds: Schema.Array(Schema.String),
});
const Count = Schema.Struct({ count: Schema.Number });
const Chunk = Schema.parseJson(
  Schema.Struct({ type: Schema.String, delta: Schema.optional(Schema.String) }),
);
const receiptFrom = (answer: string) =>
  Schema.decodeUnknownSync(Schema.parseJson(Receipt))(answer.slice(answer.indexOf("{")));
const reportFrom = (answer: string) =>
  Schema.decodeUnknownSync(Schema.parseJson(Report))(answer.slice(answer.indexOf("{")));
const idsOf = ({ taskId, attemptId }: typeof Ids.Type) => ({ taskId, attemptId });
async function until(condition: () => boolean, description: string) {
  for (let i = 0; i < 300; i++) {
    if (condition()) return;
    await Effect.runPromise(Effect.sleep("20 millis"));
  }
  throw new Error(`Timed out: ${description}`);
}
async function setup() {
  const context = await testRuntime({
    testProvider: {
      responder: async (invocation) => {
        const user = messageText(
          invocation.messages.findLast((message) => message.role === "user") ?? {
            role: "user",
            content: "",
          },
        );
        const internal = invocation.systemPrompts.some((prompt) =>
          prompt.includes("This is an automatic subagent completion follow-up"),
        );
        if (
          !internal &&
          user.startsWith("dispatch only resume ") &&
          invocation.messages.at(-1)?.role !== "tool"
        ) {
          return {
            toolCalls: [
              {
                id: "call-resume_subagent",
                name: "resume_subagent",
                arguments: user.slice("dispatch only resume ".length),
              },
            ],
          };
        }
        if (!internal && user.startsWith("review-and-adopt ")) {
          const ids = Schema.decodeUnknownSync(Schema.parseJson(Ids))(
            user.slice("review-and-adopt ".length),
          );
          const last = invocation.messages.at(-1);
          if (last?.role === "tool" && last.toolCallId === "call-review-report") {
            const report = Schema.decodeUnknownSync(Schema.parseJson(Report))(messageText(last));
            return {
              toolCalls: [
                {
                  id: "call-adopt-report",
                  name: "adopt_subagent_reports",
                  arguments: JSON.stringify({
                    reports: [{ ...ids, evidenceRefIds: report.evidenceRefIds }],
                  }),
                },
              ],
            };
          }
          if (last?.role === "tool" && last.toolCallId === "call-adopt-report")
            return { text: "Used the reviewed report." };
          return {
            toolCalls: [
              {
                id: "call-review-report",
                name: "get_subagent_report",
                arguments: JSON.stringify(ids),
              },
            ],
          };
        }
        return defaultTestResponder(invocation);
      },
    },
  });
  await context.provider!.select(context.runtime);
  const agent = await context.runtime.runPromise(AgentChat);
  const children = await context.runtime.runPromise(Subagents);
  const trace = await context.runtime.runPromise(WorkTraceStore);
  const db = await context.runtime.runPromise(Database);
  const count = (query: string) =>
    Schema.decodeUnknownSync(Count)(db.sqlite.prepare(query).get()).count;
  const idle = () =>
    count(
      `SELECT count(*) AS count FROM chat_runs WHERE thread_id = '${context.session.id}' AND status = 'running'`,
    ) === 0;
  const send = async (text: string, target = context.runtime) => {
    const targetAgent = await target.runPromise(AgentChat);
    const response = await target.runPromise(
      targetAgent.handle(
        new Request("http://local/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: context.session.id,
            runId: randomUUID(),
            messages: [{ id: randomUUID(), role: "user", content: text }],
            tools: [],
            context: [],
          }),
        }),
        context.session.id,
      ),
    );
    expect(response.status).toBe(200);
    return (await response.text())
      .split("\n")
      .flatMap((line) =>
        line.startsWith("data: ") ? [Schema.decodeUnknownSync(Chunk)(line.slice(6))] : [],
      )
      .flatMap((chunk) =>
        chunk.type === "TEXT_MESSAGE_CONTENT" && chunk.delta ? [chunk.delta] : [],
      )
      .join("");
  };
  return { ...context, agent, children, trace, db, count, idle, send };
}

describe("asynchronous subagents", () => {
  test("immediate receipt, parent-end survival, and durable idle follow-up without a synthetic user", async () => {
    const { send, children, session, provider, trace, count, idle, runtime } = await setup();
    const receipt = receiptFrom(await send("dispatch only"));
    expect(children.list(session.id)[0]?.status).toBe("running");
    expect(trace.taskDetail(session.id, receipt.taskId)?.adoptions).toEqual([]);
    expect(await send("unrelated parent work")).toContain("Hello");
    await until(
      () => children.list(session.id)[0]?.status === "completed",
      "child survives parent end",
    );
    await until(
      () =>
        provider!.adapter.invocations.some((invocation) =>
          invocation.systemPrompts.some((prompt) =>
            prompt.includes("This is an automatic subagent completion follow-up"),
          ),
        ) && idle(),
      "idle follow-up",
    );
    expect(
      count(
        "SELECT count(*) AS count FROM parent_notifications WHERE kind = 'completed' AND delivered_at IS NOT NULL",
      ),
    ).toBe(1);
    expect(count("SELECT count(*) AS count FROM nodes WHERE kind = 'user'")).toBe(2);
    expect(trace.taskDetail(session.id, receipt.taskId)?.adoptions).toEqual([]);
    const state = await runtime.runPromise(ChatState);
    const messages = await state.persistence.stores.messages.loadThread(session.id);
    expect(
      messages.some(
        (message) =>
          message.role === "assistant" &&
          messageText(message).includes("Background work completed"),
      ),
    ).toBe(true);
    expect(messages.filter((message) => message.role === "user")).toHaveLength(2);
  });
  test("concurrent children cannot cause overlapping parent turns", async () => {
    const { send, children, session, provider, count, idle, db } = await setup();
    const answer = await send("delegate twice dispatch only");
    expect(answer.match(/"status":"running"/g)).toHaveLength(2);
    expect(children.list(session.id).map((child) => child.status)).toEqual(["running", "running"]);
    const parent = send("slow parent work");
    await until(
      () => children.list(session.id).every((child) => child.status === "completed"),
      "both children finish",
    );
    expect(idle()).toBe(false);
    expect(
      provider!.adapter.invocations.some((invocation) =>
        invocation.systemPrompts.some((prompt) =>
          prompt.includes("This is an automatic subagent completion follow-up"),
        ),
      ),
    ).toBe(false);
    await parent;
    await until(
      () =>
        count(
          "SELECT count(*) AS count FROM parent_notifications WHERE kind = 'completed' AND delivered_at IS NOT NULL",
        ) === 2 && idle(),
      "post-parent notification",
    );
    const runs = Schema.decodeUnknownSync(
      Schema.Array(Schema.Struct({ started_at: Schema.Number, finished_at: Schema.Number })),
    )(
      db.sqlite
        .prepare(
          "SELECT started_at, finished_at FROM chat_runs WHERE thread_id = ? ORDER BY started_at",
        )
        .all(session.id),
    );
    for (let index = 1; index < runs.length; index++)
      expect(runs[index]!.started_at).toBeGreaterThanOrEqual(runs[index - 1]!.finished_at);
    expect(count("SELECT count(*) AS count FROM nodes WHERE kind = 'user'")).toBe(2);
  });
  test("bounded wait is not review; adoption requires retrieval in the same run", async () => {
    const { send, session, trace } = await setup();
    const ids = idsOf(receiptFrom(await send("dispatch only")));
    expect(await send(`call get_subagent_report ${JSON.stringify(ids)}`)).toContain(
      '"status":"running"',
    );
    expect(
      await send(`call wait_subagents ${JSON.stringify({ attempts: [ids], timeoutMs: 0 })}`),
    ).toContain('"status":"timed_out"');
    expect(trace.taskDetail(session.id, ids.taskId)?.adoptions).toEqual([]);
    expect(
      await send(`call wait_subagents ${JSON.stringify({ attempts: [ids], timeoutMs: 5000 })}`),
    ).toContain('"status":"completed"');
    expect(trace.taskDetail(session.id, ids.taskId)?.adoptions).toEqual([]);
    const adopt = `call adopt_subagent_reports ${JSON.stringify({ reports: [{ ...ids, evidenceRefIds: [] }] })}`;
    expect(await send(adopt)).toContain("Only reports reviewed in this run");
    expect(await send(`review-and-adopt ${JSON.stringify(ids)}`)).toContain(
      "Used the reviewed report",
    );
    const detail = trace.taskDetail(session.id, ids.taskId);
    expect(detail?.adoptions.map((entry) => entry.disposition)).toEqual([
      "returned",
      "reviewed",
      "used",
    ]);
    expect(detail?.answerClaims).toHaveLength(1);
    expect(await send(adopt)).toContain("Only reports reviewed in this run");
  });
  test("any wait returns a terminal child without cancelling its peer", async () => {
    const { send, children, session } = await setup();
    const first = receiptFrom(await send('call run_subagent {"task":"nap first dispatch only"}'));
    const second = receiptFrom(
      await send('call run_subagent {"task":"slow second dispatch only"}'),
    );
    expect(
      await send(
        `call wait_subagents ${JSON.stringify({ attempts: [idsOf(first), idsOf(second)], mode: "any", timeoutMs: 5000 })}`,
      ),
    ).toContain('"status":"completed"');
    expect(children.list(session.id).find((child) => child.id === second.subagentId)?.status).toBe(
      "running",
    );
    await children.stopTask(second.taskId);
    expect(children.list(session.id).find((child) => child.id === second.subagentId)?.status).toBe(
      "cancelled",
    );
  });
  test("cancel reaches an approval-waiting child after its parent ended", async () => {
    const { send, children, session, agent, runtime, count, trace } = await setup();
    const receipt = receiptFrom(
      await send('call run_subagent {"task":"shell: printf dispatch only"}'),
    );
    await until(
      () => trace.taskDetail(session.id, receipt.taskId)?.attempts[0]?.status === "waiting",
      "child approval wait",
    );
    expect((await runtime.runPromise(agent.cancel(session.id, null))).status).toBe(200);
    expect(children.list(session.id)[0]?.status).toBe("cancelled");
    expect(count("SELECT count(*) AS count FROM run_events WHERE kind = 'tool_completed'")).toBe(0);
    await Effect.runPromise(Effect.sleep("100 millis"));
    expect(count(`SELECT count(*) AS count FROM chat_runs WHERE thread_id = '${session.id}'`)).toBe(
      1,
    );
  });
  test("queued named attempts cancel separately and reports use exact attempts", async () => {
    const { send, children, session, trace } = await setup();
    const first = receiptFrom(
      await send('call message_subagent {"agent":"helper","message":"nap first dispatch only"}'),
    );
    const second = receiptFrom(
      await send('call message_subagent {"agent":"helper","message":"nap queued dispatch only"}'),
    );
    expect(first.subagentId).toBe(second.subagentId);
    expect(first.attemptId).not.toBe(second.attemptId);
    expect(await children.stopTask(second.taskId)).toBe("stopped");
    expect(trace.taskDetail(session.id, second.taskId)?.attempts[0]?.status).toBe("cancelled");
    expect(trace.taskDetail(session.id, first.taskId)?.attempts[0]?.status).toBe("running");
    await send(
      `call wait_subagents ${JSON.stringify({ attempts: [idsOf(first)], timeoutMs: 5000 })}`,
    );
    const firstReport = reportFrom(
      await send(`call get_subagent_report ${JSON.stringify(idsOf(first))}`),
    );
    const secondReport = reportFrom(
      await send(`call get_subagent_report ${JSON.stringify(idsOf(second))}`),
    );
    expect(firstReport.answer).toContain("nap first");
    expect(secondReport.status).toBe("cancelled");
    expect(secondReport.answer).toBe("");
  });
  test("resume returns a new running attempt receipt without awaiting its report", async () => {
    const { send, db, children, session } = await setup();
    const first = receiptFrom(await send("dispatch only"));
    await send(
      `call wait_subagents ${JSON.stringify({ attempts: [idsOf(first)], timeoutMs: 5000 })}`,
    );
    db.sqlite
      .prepare("UPDATE agent_run_attempts SET status = 'interrupted' WHERE id = ?")
      .run(first.attemptId);
    db.sqlite
      .prepare("UPDATE work_tasks SET status = 'resumable', active_attempt_id = NULL WHERE id = ?")
      .run(first.taskId);
    const resumed = receiptFrom(
      await send(
        `dispatch only resume ${JSON.stringify({ taskId: first.taskId, expectedAttemptId: first.attemptId })}`,
      ),
    );
    expect(resumed.taskId).toBe(first.taskId);
    expect(resumed.attemptId).not.toBe(first.attemptId);
    expect(children.list(session.id)[0]?.status).toBe("running");
    await send(
      `call wait_subagents ${JSON.stringify({ attempts: [idsOf(resumed)], timeoutMs: 5000 })}`,
    );
  });

  test("reports survive restart and incomplete notification deliveries are replayable", async () => {
    const { send, reopen, trace, session } = await setup();
    const receipt = receiptFrom(await send("dispatch only"));
    await send(
      `call wait_subagents ${JSON.stringify({ attempts: [idsOf(receipt)], timeoutMs: 5000 })}`,
    );
    const before = reportFrom(
      await send(`call get_subagent_report ${JSON.stringify(idsOf(receipt))}`),
    );
    const notificationId = trace.notifyParent({
      taskId: receipt.taskId,
      kind: "completed",
      summary: "Undelivered after crash",
      idempotencyKey: "crash-delivery",
    });
    expect(
      trace
        .consumeParentNotifications(session.id, "crashed-before-run-persisted")
        .map((entry) => entry.id),
    ).toContain(notificationId);
    const reopened = await reopen();
    const reopenedTrace = await reopened.runPromise(WorkTraceStore);
    expect(
      reopenedTrace.consumeParentNotifications(session.id, "retry-parent").map((entry) => entry.id),
    ).toContain(notificationId);
    const after = reportFrom(
      await send(`call get_subagent_report ${JSON.stringify(idsOf(receipt))}`, reopened),
    );
    expect(after).toEqual(before);
  });

  test("service disposal aborts and checkpoints background children", async () => {
    const { send, reopen, session } = await setup();
    const receipt = receiptFrom(await send("dispatch only"));
    const reopened = await reopen();
    const trace = await reopened.runPromise(WorkTraceStore);
    expect(trace.taskDetail(session.id, receipt.taskId)?.attempts[0]?.status).toBe("cancelled");
    expect(trace.taskDetail(session.id, receipt.taskId)?.checkpoints.length).toBeGreaterThan(0);
  });
});
