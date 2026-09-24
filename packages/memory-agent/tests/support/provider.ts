import type { ModelMessage } from "@tanstack/ai";
import { Effect, Layer, Schema } from "effect";
import {
  GlobalConfig,
  ModelUnavailable,
  ProviderRegistry,
  type AuthConnectionState,
  type Json,
  type MemoryAgentLayerOptions,
  type ModelSelection,
  type ProviderModel,
} from "memory-agent";
import {
  ScriptedTextAdapter,
  type AdapterInvocation,
  type ScriptedResponder,
  type ScriptedTurn,
} from "memory-agent/testing";
import { subscriptionAgentLoop } from "../../src/providers/subscription-runtime.ts";

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

type ToolMessage = ModelMessage & { readonly role: "tool"; readonly toolCallId: string };
const isToolMessage = (message: ModelMessage): message is ToolMessage =>
  message.role === "tool" && Schema.is(Schema.String)(message.toolCallId);

const messageText = (message: ModelMessage) =>
  Schema.is(Schema.String)(message.content)
    ? message.content
    : (message.content ?? [])
        .flatMap((part) => (part.type === "text" ? [part.content] : []))
        .join("");
const lastUserText = (messages: readonly ModelMessage[]) =>
  messageText(
    messages.findLast((message) => message.role === "user") ?? { role: "user", content: "" },
  );
const trailingTools = (messages: readonly ModelMessage[]) => {
  const tools: ToolMessage[] = [];
  for (const message of messages.toReversed()) {
    if (!isToolMessage(message)) break;
    tools.unshift(message);
  }
  return tools;
};
const toolText = (message: ToolMessage) =>
  Schema.is(Schema.String)(message.content) ? message.content : JSON.stringify(message.content);
const call = (id: string, name: string, args: Json): ScriptedTurn => ({
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
});

/** Provider-neutral behavior shared by orchestration tests formerly backed by a child process. */
export const defaultTestResponder: ScriptedResponder = async (invocation) => {
  const instructions = invocation.systemPrompts.join("\n");
  const user = lastUserText(invocation.messages);
  const tools = trailingTools(invocation.messages);

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
      input.statements?.some((statement: { text: string }) =>
        statement.text.includes("[broken-interpret]"),
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
          return target
            ? [
                {
                  target: target.id,
                  relation,
                  certainty: maybe ? "ambiguous" : "clear",
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

  if (tools.length > 0) {
    const byId = new Map(tools.map((message) => [message.toolCallId, toolText(message)]));
    // Exercise the asynchronous contract explicitly: dispatch -> wait -> retrieve. The test
    // model waits by choice; production dispatch tools no longer block their parent turn.
    if (!instructions.includes("You are a subagent") && !user.includes("dispatch only")) {
      const receipts = tools.flatMap((message) => {
        if (message.toolCallId === "call-get_subagent_report") return [];
        try {
          const value = JSON.parse(toolText(message));
          return value.status === "running" && value.taskId && value.attemptId
            ? [{ taskId: String(value.taskId), attemptId: String(value.attemptId) }]
            : [];
        } catch {
          return [];
        }
      });
      if (receipts.length > 0)
        return call("call-wait-children", "wait_subagents", { attempts: receipts });
      if (byId.has("call-wait-children")) {
        const result = Schema.decodeUnknownSync(
          Schema.fromJsonString(
            Schema.Struct({
              attempts: Schema.Array(
                Schema.Struct({ taskId: Schema.String, attemptId: Schema.String }),
              ),
            }),
          ),
        )(byId.get("call-wait-children")!);
        return {
          toolCalls: result.attempts.map((attempt, index) => ({
            id: `call-report-${index}`,
            name: "get_subagent_report",
            arguments: JSON.stringify(attempt),
          })),
        };
      }
      if ([...byId.keys()].some((id) => id.startsWith("call-report-")))
        return { text: [...byId.values()].join(" | ") };
    }
    if (byId.has("call-memory")) {
      const found = JSON.parse(byId.get("call-memory")!);
      return { text: `Found: ${found.matches?.[0]?.snippet ?? "nothing"}` };
    }
    if (byId.has("call-shell")) return { text: `Shell said ${byId.get("call-shell")}` };
    if (byId.has("call-files")) return { text: "Files checked. Heard: nothing" };
    if ([...byId].some(([id]) => id.startsWith("call-delegate-")))
      return { text: `Both: ${[...byId.values()].join(" | ")}` };
    const sequential = user.match(/^sequential weather (\d+)$/);
    if (sequential) {
      const done = invocation.messages.filter(
        (message): message is ToolMessage =>
          message.role === "tool" && message.toolCallId?.startsWith("call-seq-") === true,
      );
      if (done.length < Number(sequential[1]))
        return call(`call-seq-${done.length}`, "get_weather", { city: `City${done.length}` });
      return { text: `Looked up ${done.length}: ${done.map(toolText).join(" | ")}` };
    }
    if (byId.has("call-0") || byId.has("call-1")) {
      const answers = [byId.get("call-0"), byId.get("call-1")].filter(Boolean);
      return {
        text: answers.length > 1 ? `Both: ${answers.join(" | ")}` : `Weather says ${answers[0]}`,
      };
    }
    const generic = [...byId].find(([id]) => id.startsWith("call-"));
    if (generic) return { text: `${generic[0].slice(5)} said ${generic[1]}` };
  }

  if (instructions.includes("This is an automatic subagent completion follow-up"))
    return { text: "Background work completed." };
  if (user === "dispatch only")
    return call("call-background", "run_subagent", { task: "nap background" });
  const generic = user.match(/^call (\S+) (\{.*\})$/s);
  if (generic) return call(`call-${generic[1]}`, generic[1]!, JSON.parse(generic[2]!));
  if (user.includes("remember"))
    return call("call-memory", "find_memory", { query: "SQLite 결정" });
  if (user.includes("shell"))
    return call("call-shell", "run_shell", {
      command: user.match(/shell: (.*)$/s)?.[1]?.trim() ?? "printf approved-output",
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
    const images = invocation.messages.flatMap((message) =>
      Array.isArray(message.content) ? message.content.filter((part) => part.type === "image") : [],
    );
    return { text: `Saw ${images.length} image(s)` };
  }
  if (instructions.includes("You are a subagent")) {
    const earlier = invocation.messages.filter((message) => message.role === "user").length - 1;
    return { text: `child done: ${user} (earlier user messages: ${Math.max(0, earlier)})` };
  }
  return { text: "Hello from fast-1" };
};

export interface TestProviderOptions {
  readonly signedIn?: boolean;
  readonly responder?: ScriptedResponder;
}

export interface TestProvider {
  readonly adapter: ScriptedTextAdapter;
  readonly layer: NonNullable<MemoryAgentLayerOptions["providerRegistry"]>;
  readonly select: (
    runtime: { runPromise<A, E>(effect: Effect.Effect<A, E, GlobalConfig>): Promise<A> },
    model?: string,
    effort?: string,
  ) => Promise<ModelSelection>;
}

export function testProvider(options: TestProviderOptions = {}): TestProvider {
  let auth: AuthConnectionState = {
    provider: "openai",
    status: options.signedIn === false ? "signed-out" : "signed-in",
  };
  const adapter = new ScriptedTextAdapter(options.responder ?? defaultTestResponder);
  const layer = Layer.effect(
    ProviderRegistry,
    Effect.gen(function* () {
      const config = yield* GlobalConfig;
      const configuration = {
        provider: "openai" as const,
        auth: {
          provider: "openai" as const,
          status: Effect.sync(() => auth),
          connect: Effect.sync(() => (auth = { provider: "openai", status: "signed-in" })),
          cancel: Effect.sync(() => auth),
          disconnect: Effect.sync(() => (auth = { provider: "openai", status: "signed-out" })),
        },
        models: {
          provider: "openai" as const,
          list: Effect.succeed(models),
          selected: Effect.map(config.read, (settings) =>
            settings.provider === "openai" && settings.model && settings.reasoningEffort
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
            if (!found) return Effect.fail(new ModelUnavailable({ provider: "openai", model }));
            const effort = reasoningEffort ?? found.defaultReasoningEffort;
            if (!found.supportedReasoningEfforts.includes(effort))
              return Effect.fail(
                new ModelUnavailable({ provider: "openai", model, reasoningEffort: effort }),
              );
            return Effect.map(
              config.update({ provider: "openai", model, reasoningEffort: effort }),
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
            adapter: () => adapter,
            contextWindow: () => 200_000,
            agentLoop: subscriptionAgentLoop,
            runMiddleware: () => ({ name: "memory-agent/test-provider" }),
            steer: async () => "no_turn" as const,
          }),
      };
    }),
  );
  return {
    adapter,
    layer,
    select: async (runtime, model = "fast-1", effort = "low") => {
      await runtime.runPromise(
        Effect.flatMap(GlobalConfig, (config) =>
          config.update({ provider: "openai", model, reasoningEffort: effort }),
        ),
      );
      return { provider: "openai", model, reasoningEffort: effort };
    },
  };
}

export const providerInvocation = (
  provider: TestProvider,
  index = -1,
): AdapterInvocation | undefined =>
  index < 0 ? provider.adapter.invocations.at(index) : provider.adapter.invocations[index];
