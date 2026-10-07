import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";
import { Cause, Effect } from "effect";
import { it } from "@effect/vitest";
import { selectTestModel } from "./support/provider.ts";
import { waitUntil } from "./support/wait-until.ts";
import { describe, expect } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { ChatState } from "../src/chat-state/chat-state.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { approvalToolDefinitions } from "../src/tools/definitions.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";

const until = waitUntil;

/** A real TanStack chat client talking to AgentChat in-process, like the browser UI does. */
const approvalSetup = Effect.fnUntraced(function* () {
  const context = yield* Effect.tryPromise({
    try: () => testRuntime({ testProvider: {} }),
    catch: (cause) => new Cause.UnknownError(cause),
  });
  yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
  const client = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new ChatClient({
          tools: approvalToolDefinitions,
          connection: fetchServerSentEvents("http://127.0.0.1/api/chat", {
            fetchClient: (input, init) =>
              context.runtime.runPromise(
                Effect.flatMap(AgentChat, (agent) =>
                  agent.handle(new Request(input, init), context.session.id),
                ),
              ),
          }),
        }),
    ),
    (client) => Effect.sync(() => client.dispose()),
  );
  const lastText = () =>
    client
      .getMessages()
      .flatMap((message) =>
        message.role === "assistant"
          ? message.parts.flatMap((part) => (part.type === "text" ? [part.content] : []))
          : [],
      )
      .join("");
  return { ...context, client, lastText };
});

describe("approval-gated tools", () => {
  it.live("run_shell waits for approval, then resumes the durable app run", () =>
    Effect.gen(function* () {
      const { client, runtime, session, lastText, provider } = yield* approvalSetup();

      yield* Effect.tryPromise({
        try: () => client.sendMessage("please use the shell"),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      yield* until(() => client.getInterrupts().length === 1, "the approval request");
      expect(client.getInterrupts()[0]).toMatchObject({
        kind: "tool-approval",
        toolName: "run_shell",
        originalArgs: { command: "printf approved-output", reason: "check the shell" },
      });
      // Nothing has run yet: the call is recorded, its result is not.
      const nodes = yield* Effect.provideContext(Nodes, yield* runtime.contextEffect);
      expect(nodes.session(session.id).map((node) => node.kind)).toEqual([
        "user",
        "assistant",
        "tool_call",
      ]);

      client.resolveInterrupts(true);
      yield* until(() => lastText().startsWith("Shell said"), "the answer after approval");
      yield* until(() => !client.getIsLoading(), "the run to finish");
      expect(lastText()).toContain("approved-output");
      expect(nodes.session(session.id).map((node) => node.kind)).toEqual([
        "user",
        "assistant",
        "tool_call",
        "tool_result",
        "assistant",
      ]);
      const [, , call, result] = nodes.session(session.id);
      expect(result!.runId).toBe(call!.runId);
      expect(result!.detail).toMatchObject({ toolName: "run_shell", ok: true });

      // The durable app run resumes with the approved tool result in a fresh model invocation.
      expect(provider!.adapter.invocations).toHaveLength(2);
      expect(
        provider!.adapter.invocations[1]?.messages.some((message) => message.role === "tool"),
      ).toBe(true);
    }),
  );

  it.live("Verify can run an approval-gated shell check", () =>
    Effect.gen(function* () {
      const { client, runtime, session, lastText } = yield* approvalSetup();
      yield* Effect.provideContext(
        Effect.gen(function* () {
          const workflows = yield* Workflows;
          yield* workflows.updateGoal(session.id, {
            statement: "Verify the implementation",
            outcomes: ["Checks pass"],
            constraints: [],
            nonGoals: [],
            assumptions: [],
            openQuestions: [],
            status: "active",
          });
          yield* workflows.updatePlan(session.id, {
            summary: "Implement and verify",
            steps: [
              {
                id: "implementation",
                title: "Implement",
                description: "Make the change",
                dependsOn: [],
                acceptanceCriteria: ["The check passes"],
                ruleRefs: [],
              },
            ],
            risks: [],
            openQuestions: [],
            status: "ready",
          });
          yield* workflows.setPhase(session.id, "execute");
          yield* workflows.updateProgress(session.id, {
            steps: [{ id: "implementation", status: "completed", evidence: ["change made"] }],
            goalEvidence: [],
            planEvidence: [],
            detail: "Implementation complete",
          });
          yield* workflows.finishRun(session.id, "execute");
        }),
        yield* runtime.contextEffect,
      );

      yield* Effect.tryPromise({
        try: () => client.sendMessage("please use the shell"),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      yield* until(() => client.getInterrupts().length === 1, "the Verify approval request");
      expect(client.getInterrupts()[0]).toMatchObject({ toolName: "run_shell" });
      client.resolveInterrupts(true);
      yield* until(() => lastText().includes("approved-output"), "the Verify shell result");
      yield* until(() => !client.getIsLoading(), "the Verify run to finish");
      expect(lastText()).toContain("approved-output");
    }),
  );

  it.live("a reloaded page gets the pending approval back from the server and can answer it", () =>
    Effect.gen(function* () {
      const context = yield* approvalSetup();
      const { runtime, session } = context;
      yield* Effect.tryPromise({
        try: () => context.client.sendMessage("please use the shell"),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      yield* until(() => context.client.getInterrupts().length === 1, "the approval request");
      // The tab closes; nothing of the first client survives.
      context.client.dispose();

      const connection = fetchServerSentEvents(`http://127.0.0.1/api/chat?session=${session.id}`, {
        fetchClient: (input, init) =>
          runtime.runPromise(
            Effect.flatMap(AgentChat, (agent) =>
              (init?.method ?? "GET") === "POST"
                ? agent.handle(new Request(input, init), session.id)
                : agent.hydrate(new Request(input, init), session.id),
            ),
          ),
      });
      const reloaded = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new ChatClient({
              threadId: session.id,
              persistence: true,
              tools: approvalToolDefinitions,
              connection,
            }),
        ),
        (client) => Effect.sync(() => client.dispose()),
      );
      reloaded.attach();
      yield* until(() => reloaded.getInterrupts().length === 1, "the restored approval");
      expect(reloaded.getMessages().map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(reloaded.getInterrupts()[0]).toMatchObject({
        kind: "tool-approval",
        toolName: "run_shell",
      });

      reloaded.resolveInterrupts(true);
      const text = () =>
        reloaded
          .getMessages()
          .flatMap((message) =>
            message.role === "assistant"
              ? message.parts.flatMap((part) => (part.type === "text" ? [part.content] : []))
              : [],
          )
          .join("");
      yield* until(() => text().startsWith("Shell said"), "the answer after the reload");
      yield* until(() => !reloaded.getIsLoading(), "the run to finish");
      expect(text()).toContain("approved-output");
      reloaded.dispose();
    }),
  );

  it.live("a server restart retires an approval whose continuation no longer exists", () =>
    Effect.gen(function* () {
      const context = yield* approvalSetup();
      const { session } = context;
      yield* Effect.tryPromise({
        try: () => context.client.sendMessage("please use the shell"),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      yield* until(() => context.client.getInterrupts().length === 1, "the approval request");
      context.client.dispose();

      const runtime = yield* Effect.tryPromise({
        try: () => context.reopen(),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      const connection = fetchServerSentEvents(`http://127.0.0.1/api/chat?session=${session.id}`, {
        fetchClient: (input, init) =>
          runtime.runPromise(
            Effect.flatMap(AgentChat, (agent) =>
              agent.hydrate(new Request(input, init), session.id),
            ),
          ),
      });
      const restarted = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new ChatClient({
              threadId: session.id,
              persistence: true,
              tools: approvalToolDefinitions,
              connection,
            }),
        ),
        (client) => Effect.sync(() => client.dispose()),
      );
      restarted.attach();
      yield* until(() => restarted.getMessages().length > 0, "the restored transcript");

      expect(restarted.getInterrupts()).toEqual([]);
      expect(restarted.getError()).toBeUndefined();
      const response = yield* Effect.provideContext(
        Effect.flatMap(AgentChat, (agent) => agent.status(session.id, null)),
        yield* runtime.contextEffect,
      );
      expect(
        yield* Effect.tryPromise({
          try: () => response.json(),
          catch: (cause) => new Cause.UnknownError(cause),
        }),
      ).toMatchObject({
        running: null,
        lastRun: { status: "failed", error: { code: "server_restarted" } },
      });
      restarted.dispose();
    }),
  );

  it.live("a broken approval continuation can be discarded without running the tool", () =>
    Effect.gen(function* () {
      const context = yield* approvalSetup();
      const { runtime, session } = context;
      yield* Effect.tryPromise({
        try: () => context.client.sendMessage("please use the shell"),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      yield* until(() => context.client.getInterrupts().length === 1, "the approval request");
      context.client.dispose();

      const response = yield* Effect.provideContext(
        Effect.flatMap(AgentChat, (agent) => agent.discardInterrupts(session.id, null)),
        yield* runtime.contextEffect,
      );
      expect(
        yield* Effect.tryPromise({
          try: () => response.json(),
          catch: (cause) => new Cause.UnknownError(cause),
        }),
      ).toEqual({ discarded: 1 });
      const state = yield* Effect.provideContext(ChatState, yield* runtime.contextEffect);
      expect(
        yield* Effect.tryPromise({
          try: () => state.persistence.stores.interrupts.listPending(session.id),
          catch: (cause) => new Cause.UnknownError(cause),
        }),
      ).toEqual([]);

      const status = yield* Effect.provideContext(
        Effect.flatMap(AgentChat, (agent) => agent.status(session.id, null)),
        yield* runtime.contextEffect,
      );
      expect(
        yield* Effect.tryPromise({
          try: () => status.json(),
          catch: (cause) => new Cause.UnknownError(cause),
        }),
      ).toMatchObject({
        running: null,
        lastRun: { status: "failed", error: { code: "interrupt_continuation_lost" } },
      });
      const nodes = yield* Effect.provideContext(Nodes, yield* runtime.contextEffect);
      expect(nodes.session(session.id).filter((node) => node.kind === "tool_result")).toEqual([]);
    }),
  );

  it.live("a declined approval never runs the command and tells the model", () =>
    Effect.gen(function* () {
      const { client, runtime, session, lastText } = yield* approvalSetup();

      yield* Effect.tryPromise({
        try: () => client.sendMessage("please use the shell"),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      yield* until(() => client.getInterrupts().length === 1, "the approval request");
      client.resolveInterrupts(false);
      yield* until(() => lastText().startsWith("Shell said"), "the answer after declining");
      yield* until(() => !client.getIsLoading(), "the run to finish");
      expect(lastText()).toContain('"approved":false');
      expect(lastText()).not.toContain("approved-output");

      const nodes = yield* Effect.provideContext(Nodes, yield* runtime.contextEffect);
      const result = nodes.session(session.id).find((node) => node.kind === "tool_result");
      expect(result?.detail).toMatchObject({ toolName: "run_shell", ok: false });
    }),
  );
});
