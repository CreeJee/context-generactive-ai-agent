import {
  AuthConnectionState,
  ProviderOperationFailed,
  type AgentModelRuntime,
  type ModelRun,
} from "../../src/providers/contracts.ts";
import { isTruthy } from "../../src/truthy.ts";
import type { LanguageModel } from "effect/ai";
import {
  scriptedModel,
  scriptedSource,
  shownScriptedFailure,
} from "../../src/testing/scripted-model.ts";
import {
  Cause,
  Deferred,
  Function,
  MutableHashMap,
  MutableRef,
  Option,
  Effect,
  Layer,
  Schema,
} from "effect";
import type { StoredMessage } from "../../src/chat-store/schema.ts";
import {
  GlobalConfig,
  ModelUnavailable,
  ProviderRegistry,
  type Json,
  type MemoryAgentLayerOptions,
  type ModelSelection,
  type ProviderModel,
} from "memory-agent";
import type { ScriptedInvocation, ScriptedResponder, ScriptedTurn } from "memory-agent/testing";

const models: readonly ProviderModel[] = [
  {
    provider: "openai",
    id: "fast-1",
    displayName: "Fast",
    isDefault: true,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: ["low"],
    capabilities: { inputModalities: ["text", "image"], toolCalling: true, reasoning: true },
  },
  {
    provider: "openai",
    id: "deep-1",
    displayName: "Deep",
    isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["medium", "high"],
    capabilities: { inputModalities: ["text"], toolCalling: true, reasoning: true },
  },
];

type ToolMessage = Extract<StoredMessage, { readonly role: "tool" }>;
const isToolMessage = (message: StoredMessage): message is ToolMessage => message.role === "tool";

const messageText = (message: StoredMessage) =>
  Schema.is(Schema.String)(message.content)
    ? message.content
    : (message.content ?? [])
        .flatMap((part) => (part.type === "text" ? [part.content] : []))
        .join("");
const lastUserText = (messages: ReadonlyArray<StoredMessage>) =>
  messageText(
    messages.findLast((message) => message.role === "user") ?? { role: "user", content: "" },
  );
const trailingTools = (messages: ReadonlyArray<StoredMessage>) =>
  messages
    .slice(messages.findLastIndex((message) => !isToolMessage(message)) + 1)
    .filter(isToolMessage);
const toolText = (message: ToolMessage) =>
  Schema.is(Schema.String)(message.content) ? message.content : JSON.stringify(message.content);
const call = (id: string, name: string, args: Json): ScriptedTurn => ({
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
});

/** Provider-neutral behavior shared by orchestration tests formerly backed by a child process. */
export const defaultTestResponder = (invocation: ScriptedInvocation): ScriptedTurn => {
  const instructions = invocation.system.join("\n");
  const user = lastUserText(invocation.history);
  const tools = trailingTools(invocation.history);

  if (instructions.includes("You review one tool call")) {
    const reviewed = user.match(/Arguments \(JSON\): (.*)$/s)?.[1] ?? "";
    if (reviewed.includes("broken-review")) return { text: "not a verdict" };
    const decision = reviewed.includes("block-me")
      ? "block"
      : reviewed.includes("ask-me")
        ? "ask"
        : "allow";
    return { text: JSON.stringify({ decision, reason: `검토 결과: ${decision}` }) };
  }
  if (instructions.includes("You label statements")) {
    const input = JSON.parse(user.match(/Input \(JSON\): (.*)$/s)?.[1] ?? "{}");
    if (
      isTruthy(
        input.statements?.some((statement: { text: string }) =>
          statement.text.includes("[broken-interpret]"),
        ),
      )
    )
      return { text: "not json at all" };
    const statements = (input.statements ?? []).map(
      (statement: {
        id: string;
        text: string;
        candidates: Array<{ id: string; role: string; text: string }>;
      }) => {
        const topics = [...statement.text.matchAll(/#(\S+)/gu)].map((match) => match[1]);
        const links = [
          ...statement.text.matchAll(/\[(maybe-)?(corrects|retracts|related):([^\]]+)\]/gu),
        ].flatMap(([, maybe, relation, word]) => {
          const containing = statement.candidates.filter((candidate) =>
            candidate.text.includes(word!),
          );
          const target = containing.find((candidate) => candidate.role === "user") ?? containing[0];
          return isTruthy(target)
            ? [
                {
                  target: target.id,
                  relation,
                  certainty: isTruthy(maybe) ? "ambiguous" : "clear",
                  reason: `${word} 관련`,
                },
              ]
            : [];
        });
        if (statement.text.includes("[bad-target]"))
          links.push({
            target: "not-offered",
            relation: "corrects",
            certainty: "clear",
            reason: "x",
          });
        return { id: statement.id, topics, links };
      },
    );
    return { text: JSON.stringify({ statements }) };
  }
  if (instructions.includes("You summarize part of a conversation")) {
    const users = [...user.matchAll(/^\[user (\S+)\]$/gmu)].map((match) => match[1]);
    return user.includes("[broken-summary]")
      ? { text: "  " }
      : { text: `- 사용자 턴 ${users.length}개 (node ${users[0]})` };
  }

  // A child's completion notification reaches the parent before its next model step, or in an
  // idle follow-up once the parent's turn ended; the parent retrieves the reports it names.
  const followUp = user.includes("This is an automatic task completion follow-up");
  const reports = tools.find((message) => message.toolCallId === "call-reports");
  if (isTruthy(reports)) {
    const parsed = JSON.parse(toolText(reports));
    // One part per report, as when each was retrieved on its own.
    const parts = Array.isArray(parsed.reports)
      ? parsed.reports.map((report: Json) => JSON.stringify(report)).join(" | ")
      : toolText(reports);
    return { text: followUp ? `Background work completed. ${parts}` : parts };
  }
  // In a run: "Notification <id>; task <task>; completed: …". In a follow-up: "Notification <id>;
  // Task <task> (completed): …".
  const notified = [
    ...instructions.matchAll(
      /Notification \S+; [Tt]ask ([^\s;]+)(?:; \w+:| \(\w+\):) Subagent (?:completed|failed); (\{.*\})$/gmu,
    ),
  ].map(([, taskId, payload]) => ({ taskId, attemptId: JSON.parse(payload!).attemptId }));
  if (notified.length > 0)
    return call("call-reports", "get_subagent_reports", { attempts: notified });
  if (followUp) return { text: "Background work completed." };

  if (tools.length > 0) {
    const byId = MutableHashMap.fromIterable(
      tools.map((message) => [message.toolCallId, toolText(message)]),
    );
    if (MutableHashMap.has(byId, "call-memory")) {
      const found = JSON.parse(Option.getOrUndefined(MutableHashMap.get(byId, "call-memory"))!);
      return { text: `Found: ${found.matches?.[0]?.snippet ?? "nothing"}` };
    }
    if (MutableHashMap.has(byId, "call-shell"))
      return {
        text: `Shell said ${Option.getOrUndefined(MutableHashMap.get(byId, "call-shell"))}`,
      };
    if (MutableHashMap.has(byId, "call-files")) return { text: "Files checked. Heard: nothing" };
    if ([...byId].some(([id]) => id.startsWith("call-delegate-")))
      return { text: `Both: ${[...MutableHashMap.values(byId)].join(" | ")}` };
    const sequential = user.match(/^sequential weather (\d+)$/);
    if (isTruthy(sequential)) {
      const done = invocation.history.filter(
        (message): message is ToolMessage =>
          message.role === "tool" && message.toolCallId.startsWith("call-seq-"),
      );
      if (done.length < Number(sequential[1]))
        return call(`call-seq-${done.length}`, "get_weather", { city: `City${done.length}` });
      return { text: `Looked up ${done.length}: ${done.map(toolText).join(" | ")}` };
    }
    if (MutableHashMap.has(byId, "call-0") || MutableHashMap.has(byId, "call-1")) {
      const answers = [
        Option.getOrUndefined(MutableHashMap.get(byId, "call-0")),
        Option.getOrUndefined(MutableHashMap.get(byId, "call-1")),
      ].filter(Boolean);
      return {
        text: answers.length > 1 ? `Both: ${answers.join(" | ")}` : `Weather says ${answers[0]}`,
      };
    }
    const generic = [...byId].find(([id]) => id.startsWith("call-"));
    if (isTruthy(generic)) return { text: `${generic[0].slice(5)} said ${generic[1]}` };
  }

  if (user === "dispatch only")
    return call("call-background", "run_subagent", { task: "nap background" });
  const generic = user.match(/^call (\S+) (\{.*\})$/s);
  if (isTruthy(generic)) return call(`call-${generic[1]}`, generic[1]!, JSON.parse(generic[2]!));
  if (user.includes("remember"))
    return call("call-memory", "find_memory", { query: "SQLite 결정" });
  if (user.includes("shell"))
    return call("call-shell", "save_code_skill", {
      name: "approved-output",
      description: "Print the approved output",
      program: {
        runtime: "sh",
        script: user.match(/shell: (.*)$/s)?.[1]?.trim() ?? "printf approved-output",
      },
      reason: "check the shell",
    });
  if (user.includes("check files"))
    return { ...call("call-files", "list_files", {}), delayMs: 700 };
  if (user.includes("delegate twice"))
    return {
      toolCalls: [
        { id: "call-delegate-0", name: "run_subagent", arguments: '{"task":"nap A"}' },
        { id: "call-delegate-1", name: "run_subagent", arguments: '{"task":"nap B"}' },
      ],
    };
  if (user.includes("slow")) return { text: "done", delayMs: 2_000 };
  if (user.includes("nap")) return { text: `napped: ${user}`, delayMs: 700 };
  if (user.includes("fail")) return { failAfterText: "boom" };
  if (/^sequential weather \d+$/.test(user))
    return call("call-seq-0", "get_weather", { city: "City0" });
  if (user.includes("parallel"))
    return {
      toolCalls: [
        { id: "call-0", name: "get_weather", arguments: '{"city":"Seoul"}' },
        { id: "call-1", name: "get_weather", arguments: '{"city":"Busan"}' },
      ],
    };
  if (user.includes("weather")) return call("call-1", "get_weather", { city: "Seoul" });
  if (user.includes("look at")) {
    const images = invocation.history.flatMap((message) =>
      Array.isArray(message.content) ? message.content.filter((part) => part.type === "image") : [],
    );
    return { text: `Saw ${images.length} image(s)` };
  }
  if (instructions.includes("You are a subagent")) {
    const earlier = invocation.history.filter((message) => message.role === "user").length - 1;
    return { text: `child done: ${user} (earlier user messages: ${Math.max(0, earlier)})` };
  }
  return { text: "Hello from fast-1" };
};

export interface TestProviderOptions {
  readonly signedIn?: boolean;
  readonly responder?: ScriptedResponder;
  /** Replace scripted delays with a test-controlled gate. */
  readonly delayedTurnGate?: ScriptedTurn["waitFor"];
  /** Run chats on this model instead of the scripted one, such as a provider's own model. */
  readonly runModel?: AgentModelRuntime["model"];
  /** Wraps the scripted model the Effect AI loop runs on, such as to hold its stream. */
  readonly model?: (model: LanguageModel.LanguageModel) => LanguageModel.LanguageModel;
}

export function turnGate() {
  const gate = Deferred.makeUnsafe<void>();
  return {
    waitFor: Deferred.await(gate),
    release: () => void Deferred.doneUnsafe(gate, Effect.void),
  };
}

export interface TestProvider {
  /** Every step the scripted model was asked for, in order, across runs. */
  readonly invocations: ReadonlyArray<ScriptedInvocation>;
  readonly layer: NonNullable<MemoryAgentLayerOptions["providerRegistry"]>;
  readonly select: (
    runtime: { runPromise<A, E>(effect: Effect.Effect<A, E, GlobalConfig>): Promise<A> },
    model?: string,
    effort?: string,
  ) => Promise<ModelSelection>;
}

/** Effect tests select a model in their current owner context; Promise fixtures keep the wrapper. */
export const selectTestModel = Effect.fn("selectTestModel")(function* (
  model: string = "fast-1",
  effort: string = "low",
) {
  const config = yield* GlobalConfig;
  yield* config
    .update({ provider: "openai", model, reasoningEffort: effort })
    .pipe(
      Effect.mapError(() =>
        ProviderOperationFailed.make({ provider: "openai", operation: "model" }),
      ),
    );
  return { provider: "openai" as const, model, reasoningEffort: effort };
});

export function testProvider(options: TestProviderOptions = {}): TestProvider {
  const auth = MutableRef.make<AuthConnectionState>(
    options.signedIn === false
      ? AuthConnectionState["signed-out"]({ provider: "openai" })
      : AuthConnectionState["signed-in"]({ provider: "openai" }),
  );
  const responder = options.responder ?? defaultTestResponder;
  const respond = Effect.fn("testProvider.responder")((invocation: ScriptedInvocation) =>
    Effect.try({
      try: () => ({ response: responder(invocation) }),
      catch: (cause) => new Cause.UnknownError(cause),
    }).pipe(
      Effect.flatMap(({ response }) =>
        Effect.isEffect(response) ? response : Effect.succeed(response),
      ),
      Effect.map((turn) => {
        if (!isTruthy(options.delayedTurnGate) || turn.delayMs === undefined) return turn;
        const { delayMs: _delayMs, ...gatedTurn } = turn;
        return { ...gatedTurn, waitFor: options.delayedTurnGate };
      }),
    ),
  );
  const invocations: Array<ScriptedInvocation> = [];
  /** Each step the loop asks for is recorded, then answered by the responder. */
  const respondToStep = (invocation: ScriptedInvocation) => {
    invocations.push(invocation);
    return respond(invocation);
  };
  const layer = Layer.effect(
    ProviderRegistry,
    Effect.gen(function* () {
      const config = yield* GlobalConfig;
      const scripted = yield* scriptedModel(respondToStep);
      const configuration = {
        provider: "openai" as const,
        auth: {
          provider: "openai" as const,
          status: Effect.sync(() => MutableRef.get(auth)),
          connect: Effect.sync(() =>
            MutableRef.setAndGet(auth, AuthConnectionState["signed-in"]({ provider: "openai" })),
          ),
          cancel: Effect.sync(() => MutableRef.get(auth)),
          disconnect: Effect.sync(() =>
            MutableRef.setAndGet(auth, AuthConnectionState["signed-out"]({ provider: "openai" })),
          ),
        },
        models: {
          provider: "openai" as const,
          list: Effect.succeed(models),
          selected: Effect.map(config.read, (settings) =>
            settings.provider === "openai" &&
            isTruthy(settings.model) &&
            isTruthy(settings.reasoningEffort)
              ? {
                  provider: "openai" as const,
                  model: settings.model,
                  reasoningEffort: settings.reasoningEffort,
                }
              : null,
          ),
          acceptsImages: (model: string) =>
            Effect.succeed(
              models
                .find((candidate) => candidate.id === model)
                ?.capabilities.inputModalities.includes("image") ?? false,
            ),
          cheapestEffort: (selection: ModelSelection) => Effect.succeed(selection),
          select: (model: string, reasoningEffort?: string) => {
            const found = models.find((candidate) => candidate.id === model);
            if (!isTruthy(found))
              return Effect.fail(ModelUnavailable.make({ provider: "openai", model }));
            const effort = reasoningEffort ?? found.defaultReasoningEffort;
            if (!found.supportedReasoningEfforts.includes(effort))
              return Effect.fail(
                ModelUnavailable.make({ provider: "openai", model, reasoningEffort: effort }),
              );
            return Effect.map(
              config
                .update({ provider: "openai", model, reasoningEffort: effort })
                .pipe(
                  Effect.mapError(() =>
                    ProviderOperationFailed.make({ provider: "openai", operation: "model" }),
                  ),
                ),
              () => ({ provider: "openai" as const, model, reasoningEffort: effort }),
            );
          },
        },
      };
      return {
        providers: ["openai" as const],
        get: () => Effect.succeed(configuration),
        runtime: () =>
          Effect.succeed({
            provider: "openai" as const,
            model:
              options.runModel ??
              ((_selection: ModelSelection, run: ModelRun) =>
                Effect.map(scripted.forRun(run), (model) => ({
                  model: options.model?.(model) ?? model,
                  source: scriptedSource,
                  shownFailure: shownScriptedFailure,
                }))),
            contextWindow: () => 200_000,
          }),
      };
    }),
  );
  return {
    invocations,
    layer,
    select: (runtime, model, effort) => runtime.runPromise(selectTestModel(model, effort)),
  };
}

const isProvider = Schema.is(Schema.Struct({ invocations: Schema.ObjectKeyword }));

export const providerInvocation: {
  (provider: TestProvider, index?: number): ScriptedInvocation | undefined;
  (index?: number): (provider: TestProvider) => ScriptedInvocation | undefined;
} = Function.dual(
  (args) => isProvider(args[0]),
  (provider: TestProvider, index = -1): ScriptedInvocation | undefined =>
    index < 0 ? provider.invocations.at(index) : provider.invocations[index],
);
