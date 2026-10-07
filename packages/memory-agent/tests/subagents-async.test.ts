import { Cause, Layer } from "effect";
import { Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../src/truthy.ts";
import { Crypto, Deferred, Fiber, Schedule } from "effect";
import { NodeCrypto } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe, expect } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { ChatState } from "../src/chat-state/chat-state.ts";
import { Database } from "../src/db/database.ts";
import { messageText } from "../src/messages/text.ts";
import { Subagents } from "../src/subagents/subagents.ts";
import { WorkTraceStore } from "../src/work-trace/store.ts";
import { defaultTestResponder } from "./support/provider.ts";
import { testRuntime } from "./support/runtime.ts";
const sdkCall = <A>(call: () => A | PromiseLike<A>) =>
  Effect.tryPromise(() => Promise.resolve(call()));

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
const Count = Schema.Struct({ count: Schema.Finite });
const Chunk = Schema.fromJsonString(
  Schema.Struct({ type: Schema.String, delta: Schema.optional(Schema.String) }),
);
const receiptFrom = (answer: string) =>
  EffectFunction.flow(
    Schema.decodeResult(Schema.fromJsonString(Receipt)),
    Result.getOrThrow,
  )(answer.slice(answer.indexOf("{")));
const reportFrom = (answer: string) =>
  EffectFunction.flow(
    Schema.decodeResult(Schema.fromJsonString(Report)),
    Result.getOrThrow,
  )(answer.slice(answer.indexOf("{")));
const idsOf = ({ taskId, attemptId }: typeof Ids.Type) => ({ taskId, attemptId });
const until = Effect.fn("untilSubagentState")(function* (
  condition: () => boolean,
  description: string,
) {
  yield* Effect.sync(condition).pipe(
    Effect.repeat({ while: (ready) => !ready, schedule: Schedule.spaced("20 millis") }),
    Effect.timeout("6 seconds"),
    Effect.mapError((cause) => new Cause.UnknownError(new Error(description, { cause }))),
  );
});
const setup = Effect.fn("setupAsyncSubagents")(function* () {
  const crypto = yield* Crypto.Crypto;
  const delayed: Array<{ user: string; gate: Deferred.Deferred<void> }> = [];
  yield* Effect.addFinalizer(() =>
    Effect.forEach(delayed, ({ gate }) => Deferred.succeed(gate, undefined)).pipe(Effect.asVoid),
  );
  const context = yield* sdkCall(() =>
    testRuntime({
      testProvider: {
        responder: Effect.fn("asyncSubagentResponder")(function* (invocation) {
          const user = messageText(
            invocation.messages.findLast((message) => message.role === "user") ?? {
              role: "user",
              content: "",
            },
          );
          const internal = invocation.systemPrompts.some((prompt) =>
            prompt.includes("This is an automatic task completion follow-up"),
          );
          if (!internal && user.startsWith("review-batch ")) {
            const attempts = EffectFunction.flow(
              Schema.decodeResult(Schema.fromJsonString(Schema.Array(Ids))),
              Result.getOrThrow,
            )(user.slice("review-batch ".length));
            const last = invocation.messages.at(-1);
            if (last?.role === "tool" && last.toolCallId === "call-review-batch") {
              const { reports } = EffectFunction.flow(
                Schema.decodeResult(
                  Schema.fromJsonString(Schema.Struct({ reports: Schema.Array(Report) })),
                ),
                Result.getOrThrow,
              )(messageText(last));
              return {
                toolCalls: [
                  {
                    id: "call-adopt-batch",
                    name: "adopt_subagent_reports",
                    arguments: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                      reports: reports.map((report) => ({
                        ...idsOf(report),
                        evidenceRefIds: report.evidenceRefIds,
                      })),
                    }).pipe(Effect.orDie),
                  },
                ],
              };
            }
            if (last?.role === "tool" && last.toolCallId === "call-adopt-batch")
              return { text: "Used both reviewed reports." };
            return {
              toolCalls: [
                {
                  id: "call-review-batch",
                  name: "get_subagent_reports",
                  arguments: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                    attempts,
                  }).pipe(Effect.orDie),
                },
              ],
            };
          }
          if (!internal && user === "delegate and keep working") {
            const last = invocation.messages.at(-1);
            switch (last?.role === "tool" ? last.toolCallId : undefined) {
              case "call-background": {
                const receipt = EffectFunction.flow(
                  Schema.decodeResult(Schema.fromJsonString(Receipt)),
                  Result.getOrThrow,
                )(messageText(last!));
                return {
                  toolCalls: [
                    {
                      id: "call-check-children",
                      name: "wait_subagents",
                      arguments: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                        attempts: [idsOf(receipt)],
                      }).pipe(Effect.orDie),
                    },
                  ],
                };
              }
              case "call-check-children":
                expect(messageText(last!)).toContain('"status":"pending"');
                return {
                  toolCalls: [
                    {
                      id: "call-independent-work",
                      name: "find_memory",
                      arguments: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                        query: "SQLite 결정",
                      }).pipe(Effect.orDie),
                    },
                  ],
                };
              case "call-independent-work":
                return { text: "Independent parent work finished." };
              default:
                return {
                  toolCalls: [
                    {
                      id: "call-background",
                      name: "run_subagent",
                      arguments: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                        task: "nap background",
                      }).pipe(Effect.orDie),
                    },
                  ],
                };
            }
          }
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
            const ids = EffectFunction.flow(
              Schema.decodeResult(Schema.fromJsonString(Ids)),
              Result.getOrThrow,
            )(user.slice("review-and-adopt ".length));
            const last = invocation.messages.at(-1);
            if (last?.role === "tool" && last.toolCallId === "call-review-report") {
              const report = EffectFunction.flow(
                Schema.decodeResult(Schema.fromJsonString(Report)),
                Result.getOrThrow,
              )(messageText(last));
              return {
                toolCalls: [
                  {
                    id: "call-adopt-report",
                    name: "adopt_subagent_reports",
                    arguments: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                      reports: [{ ...ids, evidenceRefIds: report.evidenceRefIds }],
                    }).pipe(Effect.orDie),
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
                  arguments: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
                    ids,
                  ).pipe(Effect.orDie),
                },
              ],
            };
          }
          const turn = yield* sdkCall(() => defaultTestResponder(invocation));
          if (turn.delayMs === undefined) return turn;
          const { delayMs: _delayMs, ...ready } = turn;
          const gate = yield* Deferred.make<void>();
          delayed.push({ user, gate });
          return { ...ready, waitFor: Deferred.await(gate) };
        }),
      },
    }),
  );
  yield* sdkCall(() => context.provider!.select(context.runtime));
  const agent = yield* Effect.provideContext(AgentChat, yield* context.runtime.contextEffect);
  const children = yield* Effect.provideContext(Subagents, yield* context.runtime.contextEffect);
  const trace = yield* Effect.provideContext(WorkTraceStore, yield* context.runtime.contextEffect);
  const db = yield* Effect.provideContext(Database, yield* context.runtime.contextEffect);
  const count = (query: string) =>
    EffectFunction.flow(
      Schema.decodeUnknownResult(Count),
      Result.getOrThrow,
    )(db.sqlite.prepare(query).get()).count;
  const idle = () =>
    count(
      `SELECT count(*) AS count FROM chat_runs WHERE thread_id = '${context.session.id}' AND status = 'running'`,
    ) === 0;
  const send = Effect.fn("sendAsyncSubagentTurn")(function* (
    text: string,
    target: typeof context.runtime = context.runtime,
  ) {
    const services = yield* target.contextEffect;
    const agentEffect: Effect.Effect<typeof agent, unknown> = Effect.provideContext(
      AgentChat,
      services,
    );
    const targetAgent = yield* agentEffect;
    const request = new Request("http://local/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        threadId: context.session.id,
        runId: yield* crypto.randomUUIDv4,
        messages: [{ id: yield* crypto.randomUUIDv4, role: "user", content: text }],
        tools: [],
        context: [],
      }).pipe(Effect.orDie),
    });
    const responseEffect: Effect.Effect<Response, unknown> = Effect.provideContext(
      targetAgent.handle(request, context.session.id),
      services,
    );
    const response = yield* responseEffect;
    expect(response.status).toBe(200);
    const responseText: Effect.Effect<string, Cause.UnknownError> = sdkCall(() => response.text());
    return (yield* responseText)
      .split("\n")
      .flatMap((line) =>
        line.startsWith("data: ")
          ? [EffectFunction.flow(Schema.decodeResult(Chunk), Result.getOrThrow)(line.slice(6))]
          : [],
      )
      .flatMap((chunk) =>
        chunk.type === "TEXT_MESSAGE_CONTENT" && isTruthy(chunk.delta) ? [chunk.delta] : [],
      )
      .join("");
  });
  const releaseDelayed = Effect.fn("releaseDelayedSubagents")(function* (text: string, count = 1) {
    yield* until(
      () => delayed.filter((entry) => entry.user.includes(text)).length >= count,
      `delayed ${text}`,
    );
    for (let index = delayed.length - 1; index >= 0; index--) {
      const entry = delayed[index]!;
      if (!entry.user.includes(text)) continue;
      delayed.splice(index, 1);
      yield* Deferred.succeed(entry.gate, undefined);
    }
  });
  return { ...context, agent, children, trace, db, count, idle, send, releaseDelayed };
});

describe("asynchronous subagents", () => {
  it.live("batch retrieval reviews each attempt for adoption in the same run", () =>
    Effect.scoped(
      withCrypto(
        Effect.gen(function* () {
          const { send, trace, session, releaseDelayed } = yield* setup();
          const first = receiptFrom(
            yield* send('call run_subagent {"task":"nap first dispatch only"}'),
          );
          const second = receiptFrom(
            yield* send('call run_subagent {"task":"nap second dispatch only"}'),
          );
          yield* releaseDelayed("nap", 2);
          const attempts = [idsOf(first), idsOf(second)];
          yield* send(
            `call wait_subagents ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ attempts, timeoutMs: 5000 }).pipe(Effect.orDie)}`,
          );
          expect(
            yield* send(
              `review-batch ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(attempts).pipe(Effect.orDie)}`,
            ),
          ).toBe("Used both reviewed reports.");
          for (const attempt of attempts)
            expect(
              trace
                .taskDetail(session.id, attempt.taskId)
                ?.adoptions.map((entry) => entry.disposition),
            ).toEqual(["returned", "reviewed", "used"]);
        }),
      ),
    ),
  );
  it.live(
    "default wait lets the parent execute independent tools in the same turn before the child finishes",
    () =>
      Effect.scoped(
        withCrypto(
          Effect.gen(function* () {
            const { send, children, session, provider, releaseDelayed, idle } = yield* setup();
            expect(yield* send("delegate and keep working")).toBe(
              "Independent parent work finished.",
            );
            expect(children.list(session.id)[0]?.status).toBe("running");
            const parentSteps = provider!.adapter.invocations.filter((invocation) =>
              invocation.messages.some(
                (message) =>
                  message.role === "user" && messageText(message) === "delegate and keep working",
              ),
            );
            expect(
              parentSteps.some((invocation) =>
                invocation.messages.some(
                  (message) =>
                    message.role === "tool" && message.toolCallId === "call-independent-work",
                ),
              ),
            ).toBe(true);
            yield* releaseDelayed("nap");
            yield* until(
              () => children.list(session.id)[0]?.status === "completed" && idle(),
              "child finishes after parent work",
            );
          }),
        ),
      ),
  );
  it.live(
    "immediate receipt, parent-end survival, and durable idle follow-up without a synthetic user",
    () =>
      Effect.scoped(
        withCrypto(
          Effect.gen(function* () {
            const {
              send,
              children,
              session,
              provider,
              trace,
              count,
              idle,
              runtime,
              releaseDelayed,
            } = yield* setup();
            const receipt = receiptFrom(yield* send("dispatch only"));
            expect(children.list(session.id)[0]?.status).toBe("running");
            expect(trace.taskDetail(session.id, receipt.taskId)?.adoptions).toEqual([]);
            expect(yield* send("unrelated parent work")).toContain("Hello");
            yield* releaseDelayed("nap");
            yield* until(
              () => children.list(session.id)[0]?.status === "completed",
              "child survives parent end",
            );
            yield* until(
              () =>
                provider!.adapter.invocations.some((invocation) =>
                  invocation.systemPrompts.some((prompt) =>
                    prompt.includes("This is an automatic task completion follow-up"),
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
            const state = yield* Effect.provideContext(ChatState, yield* runtime.contextEffect);
            const messages = yield* sdkCall(() =>
              state.persistence.stores.messages.loadThread(session.id),
            );
            expect(
              messages.some(
                (message) =>
                  message.role === "assistant" &&
                  messageText(message).includes("Background work completed"),
              ),
            ).toBe(true);
            expect(messages.filter((message) => message.role === "user")).toHaveLength(2);
          }),
        ),
      ),
  );
  it.live("concurrent children cannot cause overlapping parent turns", () =>
    Effect.scoped(
      withCrypto(
        Effect.gen(function* () {
          const { send, children, session, provider, count, idle, db, releaseDelayed } =
            yield* setup();
          const answer = yield* send("delegate twice dispatch only");
          expect(answer.match(/"status":"running"/g)).toHaveLength(2);
          expect(children.list(session.id).map((child) => child.status)).toEqual([
            "running",
            "running",
          ]);
          const parent = yield* Effect.forkChild(send("slow parent work"), {
            startImmediately: true,
          });
          yield* releaseDelayed("nap", 2);
          yield* until(
            () => children.list(session.id).every((child) => child.status === "completed"),
            "both children finish",
          );
          expect(idle()).toBe(false);
          expect(
            provider!.adapter.invocations.some((invocation) =>
              invocation.systemPrompts.some((prompt) =>
                prompt.includes("This is an automatic task completion follow-up"),
              ),
            ),
          ).toBe(false);
          yield* releaseDelayed("slow parent work");
          yield* Fiber.join(parent);
          yield* until(
            () =>
              count(
                "SELECT count(*) AS count FROM parent_notifications WHERE kind = 'completed' AND delivered_at IS NOT NULL",
              ) === 2 && idle(),
            "post-parent notification",
          );
          const runs = EffectFunction.flow(
            Schema.decodeUnknownResult(
              Schema.Array(
                Schema.Struct({ started_at: Schema.Finite, finished_at: Schema.Finite }),
              ),
            ),
            Result.getOrThrow,
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
        }),
      ),
    ),
  );
  it.live("bounded wait is not review; adoption requires retrieval in the same run", () =>
    Effect.scoped(
      withCrypto(
        Effect.gen(function* () {
          const { send, session, trace, releaseDelayed } = yield* setup();
          const ids = idsOf(receiptFrom(yield* send("dispatch only")));
          expect(
            yield* send(
              `call get_subagent_report ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(ids).pipe(Effect.orDie)}`,
            ),
          ).toContain('"status":"running"');
          expect(
            yield* send(
              `call wait_subagents ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ attempts: [ids], timeoutMs: 0 }).pipe(Effect.orDie)}`,
            ),
          ).toContain('"status":"pending"');
          expect(
            yield* send(
              `call wait_subagents ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ attempts: [ids], timeoutMs: 1 }).pipe(Effect.orDie)}`,
            ),
          ).toContain('"status":"timed_out"');
          expect(trace.taskDetail(session.id, ids.taskId)?.adoptions).toEqual([]);
          yield* releaseDelayed("nap");
          expect(
            yield* send(
              `call wait_subagents ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ attempts: [ids], timeoutMs: 5000 }).pipe(Effect.orDie)}`,
            ),
          ).toContain('"status":"completed"');
          expect(
            yield* send(
              `call wait_subagents ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ attempts: [ids] }).pipe(Effect.orDie)}`,
            ),
          ).toContain('"status":"completed"');
          expect(trace.taskDetail(session.id, ids.taskId)?.adoptions).toEqual([]);
          const adopt = `call adopt_subagent_reports ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ reports: [{ ...ids, evidenceRefIds: [] }] }).pipe(Effect.orDie)}`;
          expect(yield* send(adopt)).toContain("Only reports reviewed in this run");
          expect(
            yield* send(
              `review-and-adopt ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(ids).pipe(Effect.orDie)}`,
            ),
          ).toContain("Used the reviewed report");
          const detail = trace.taskDetail(session.id, ids.taskId);
          expect(detail?.adoptions.map((entry) => entry.disposition)).toEqual([
            "returned",
            "reviewed",
            "used",
          ]);
          expect(detail?.answerClaims).toHaveLength(1);
          expect(yield* send(adopt)).toContain("Only reports reviewed in this run");
        }),
      ),
    ),
  );
  it.live("any wait returns a terminal child without cancelling its peer", () =>
    Effect.scoped(
      withCrypto(
        Effect.gen(function* () {
          const { send, children, session, releaseDelayed } = yield* setup();
          const first = receiptFrom(
            yield* send('call run_subagent {"task":"nap first dispatch only"}'),
          );
          const second = receiptFrom(
            yield* send('call run_subagent {"task":"slow second dispatch only"}'),
          );
          yield* releaseDelayed("nap first");
          expect(
            yield* send(
              `call wait_subagents ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ attempts: [idsOf(first), idsOf(second)], mode: "any", timeoutMs: 5000 }).pipe(Effect.orDie)}`,
            ),
          ).toContain('"status":"completed"');
          expect(
            children.list(session.id).find((child) => child.id === second.subagentId)?.status,
          ).toBe("running");
          yield* sdkCall(() => children.stopTask(second.taskId));
          expect(
            children.list(session.id).find((child) => child.id === second.subagentId)?.status,
          ).toBe("cancelled");
        }),
      ),
    ),
  );
  it.live("cancel reaches an approval-waiting child after its parent ended", () =>
    Effect.scoped(
      withCrypto(
        Effect.gen(function* () {
          const { send, children, session, agent, runtime, count, trace } = yield* setup();
          const receipt = receiptFrom(
            yield* send('call run_subagent {"task":"shell: printf dispatch only"}'),
          );
          yield* until(
            () => trace.taskDetail(session.id, receipt.taskId)?.attempts[0]?.status === "waiting",
            "child approval wait",
          );
          expect(
            (yield* Effect.provideContext(
              agent.cancel(session.id, null),
              yield* runtime.contextEffect,
            )).status,
          ).toBe(200);
          expect(children.list(session.id)[0]?.status).toBe("cancelled");
          expect(
            count("SELECT count(*) AS count FROM run_events WHERE kind = 'tool_completed'"),
          ).toBe(0);
          yield* Effect.sleep("100 millis");
          expect(
            count(`SELECT count(*) AS count FROM chat_runs WHERE thread_id = '${session.id}'`),
          ).toBe(1);
        }),
      ),
    ),
  );
  it.live("queued named attempts cancel separately and reports use exact attempts", () =>
    Effect.scoped(
      withCrypto(
        Effect.gen(function* () {
          const { send, children, session, trace, releaseDelayed } = yield* setup();
          const first = receiptFrom(
            yield* send(
              'call message_subagent {"agent":"helper","message":"nap first dispatch only"}',
            ),
          );
          const second = receiptFrom(
            yield* send(
              'call message_subagent {"agent":"helper","message":"nap queued dispatch only"}',
            ),
          );
          expect(first.subagentId).toBe(second.subagentId);
          expect(first.attemptId).not.toBe(second.attemptId);
          expect(yield* sdkCall(() => children.stopTask(second.taskId))).toBe("stopped");
          expect(trace.taskDetail(session.id, second.taskId)?.attempts[0]?.status).toBe(
            "cancelled",
          );
          expect(trace.taskDetail(session.id, first.taskId)?.attempts[0]?.status).toBe("running");
          yield* releaseDelayed("nap first");
          yield* send(
            `call wait_subagents ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ attempts: [idsOf(first)], timeoutMs: 5000 }).pipe(Effect.orDie)}`,
          );
          const firstReport = reportFrom(
            yield* send(
              `call get_subagent_report ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(idsOf(first)).pipe(Effect.orDie)}`,
            ),
          );
          const secondReport = reportFrom(
            yield* send(
              `call get_subagent_report ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(idsOf(second)).pipe(Effect.orDie)}`,
            ),
          );
          expect(firstReport.answer).toContain("nap first");
          expect(secondReport.status).toBe("cancelled");
          expect(secondReport.answer).toBe("");
        }),
      ),
    ),
  );
  it.live("resume returns a new running attempt receipt without awaiting its report", () =>
    Effect.scoped(
      withCrypto(
        Effect.gen(function* () {
          const { send, db, children, session, releaseDelayed } = yield* setup();
          const first = receiptFrom(yield* send("dispatch only"));
          yield* releaseDelayed("nap");
          yield* send(
            `call wait_subagents ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ attempts: [idsOf(first)], timeoutMs: 5000 }).pipe(Effect.orDie)}`,
          );
          db.sqlite
            .prepare("UPDATE agent_run_attempts SET status = 'interrupted' WHERE id = ?")
            .run(first.attemptId);
          db.sqlite
            .prepare(
              "UPDATE work_tasks SET status = 'resumable', active_attempt_id = NULL WHERE id = ?",
            )
            .run(first.taskId);
          const resumed = receiptFrom(
            yield* send(
              `dispatch only resume ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ taskId: first.taskId, expectedAttemptId: first.attemptId }).pipe(Effect.orDie)}`,
            ),
          );
          expect(resumed.taskId).toBe(first.taskId);
          expect(resumed.attemptId).not.toBe(first.attemptId);
          expect(children.list(session.id)[0]?.status).toBe("running");
          yield* releaseDelayed("nap");
          yield* send(
            `call wait_subagents ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ attempts: [idsOf(resumed)], timeoutMs: 5000 }).pipe(Effect.orDie)}`,
          );
        }),
      ),
    ),
  );

  it.live("reports survive restart and incomplete notification deliveries are replayable", () =>
    Effect.scoped(
      withCrypto(
        Effect.gen(function* () {
          const { send, reopen, trace, session, releaseDelayed } = yield* setup();
          const receipt = receiptFrom(yield* send("dispatch only"));
          yield* releaseDelayed("nap");
          yield* send(
            `call wait_subagents ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ attempts: [idsOf(receipt)], timeoutMs: 5000 }).pipe(Effect.orDie)}`,
          );
          const before = reportFrom(
            yield* send(
              `call get_subagent_report ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(idsOf(receipt)).pipe(Effect.orDie)}`,
            ),
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
          const reopened = yield* sdkCall(() => reopen());
          const reopenedTrace = yield* Effect.provideContext(
            WorkTraceStore,
            yield* reopened.contextEffect,
          );
          expect(
            reopenedTrace
              .consumeParentNotifications(session.id, "retry-parent")
              .map((entry) => entry.id),
          ).toContain(notificationId);
          const after = reportFrom(
            yield* send(
              `call get_subagent_report ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(idsOf(receipt)).pipe(Effect.orDie)}`,
              reopened,
            ),
          );
          expect(after).toEqual(before);
        }),
      ),
    ),
  );

  it.live("a held parent notification stays out of automatic follow-up after restart", () =>
    Effect.scoped(
      withCrypto(
        Effect.gen(function* () {
          const { send, reopen, trace, session } = yield* setup();
          const receipt = receiptFrom(yield* send("dispatch only"));
          trace.holdParentNotifications(session.id);
          const notificationId = trace.notifyParent({
            taskId: receipt.taskId,
            kind: "completed",
            summary: "Wait for an explicit user turn",
            idempotencyKey: "held-notification",
          });
          expect(notificationId).not.toBeNull();
          expect(trace.pendingParentNotificationSessions()).not.toContain(session.id);

          const reopened = yield* sdkCall(() => reopen());
          const reopenedTrace = yield* Effect.provideContext(
            WorkTraceStore,
            yield* reopened.contextEffect,
          );
          expect(reopenedTrace.parentNotificationsHeld(session.id)).toBe(true);
          expect(reopenedTrace.pendingParentNotificationSessions()).not.toContain(session.id);
          reopenedTrace.resumeParentNotifications(session.id);
          expect(reopenedTrace.pendingParentNotificationSessions()).toContain(session.id);
        }),
      ),
    ),
  );

  it.live("service disposal aborts and checkpoints background children", () =>
    Effect.scoped(
      withCrypto(
        Effect.gen(function* () {
          const { send, reopen, session } = yield* setup();
          const receipt = receiptFrom(yield* send("dispatch only"));
          const reopened = yield* sdkCall(() => reopen());
          const trace = yield* Effect.provideContext(WorkTraceStore, yield* reopened.contextEffect);
          expect(trace.taskDetail(session.id, receipt.taskId)?.attempts[0]?.status).toBe(
            "cancelled",
          );
          expect(trace.taskDetail(session.id, receipt.taskId)?.checkpoints.length).toBeGreaterThan(
            0,
          );
        }),
      ),
    ),
  );
});

const withCrypto = Effect.fn("AsyncSubagentTest.crypto")(function* <A, E, R>(
  program: Effect.Effect<A, E, R>,
) {
  const services = yield* Layer.build(NodeCrypto.layer);
  return yield* Effect.provideContext(program, services);
});
