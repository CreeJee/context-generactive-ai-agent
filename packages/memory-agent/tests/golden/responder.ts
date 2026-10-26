import { Deferred, Effect, Option, Schema } from "effect";
import type { ModelMessage } from "@tanstack/ai";
import type {
  ScriptedResponder,
  ScriptedToolCall,
  ScriptedTurn,
} from "../../src/testing/scripted-adapter.ts";
import type { JsonValue } from "../../src/json.ts";
import { scopedCallId } from "../support/chat-client.ts";
import { defaultTestResponder } from "../support/provider.ts";

/**
 * Golden scenarios script the model per user message `golden:<scenario>`: the n-th model call
 * after that message gets the n-th turn. Tool call ids carry the conversation, as provider ids are
 * unique across the database. Anything else (reviews, subagents) gets the shared test model.
 */

const call = (id: string, name: string, args: JsonValue): ScriptedToolCall => ({
  id,
  name,
  arguments: JSON.stringify(args),
});

/** A tool that always waits for approval in `ask` mode and for the review in `auto` mode. */
const saveSkill = (id: string, script: string) =>
  call(id, "save_code_skill", {
    name: id,
    description: "Print a line",
    program: { runtime: "sh", script },
    reason: "golden scenario",
  });

const scripts = {
  read: [{ toolCalls: [call("read", "read_file", { path: "notes.txt" })] }, { text: "read done" }],
  "parallel-reads": [
    {
      toolCalls: [
        call("read-a", "read_file", { path: "notes.txt" }),
        call("read-b", "list_files", {}),
      ],
    },
    { text: "both read" },
  ],
  write: [
    { toolCalls: [call("write", "write_file", { path: "out.txt", content: "written\n" })] },
    { text: "write done" },
  ],
  approval: [{ toolCalls: [saveSkill("approval", "printf approved")] }, { text: "approval done" }],
  // The shared test model's review answers "ask" for arguments that mention ask-me.
  review: [{ toolCalls: [saveSkill("review", "printf ask-me")] }, { text: "review done" }],
  mixed: [
    {
      toolCalls: [
        call("mixed-read", "read_file", { path: "notes.txt" }),
        saveSkill("mixed-skill", "printf mixed"),
        call("mixed-list", "list_files", {}),
      ],
    },
    { text: "mixed done" },
  ],
  fail: [{ failAfterText: "partial answer" }],
  cancel: [{ text: "never shown", waitFor: Effect.never }],
  "subagent-first": [
    { toolCalls: [call("first", "run_subagent", { agent: "helper", task: "first task" })] },
    { text: "first started" },
  ],
  "subagent-second": [
    { toolCalls: [call("second", "run_subagent", { agent: "helper", task: "second task" })] },
    { text: "second started" },
  ],
} satisfies { readonly [scenario: string]: ReadonlyArray<ScriptedTurn> };

const Scenario = Schema.Literals([
  "read",
  "parallel-reads",
  "write",
  "approval",
  "review",
  "mixed",
  "fail",
  "cancel",
  "subagent-first",
  "subagent-second",
]);
export type Scenario = typeof Scenario.Type;
const decodeScenario = Schema.decodeUnknownOption(Scenario);

const isString = Schema.is(Schema.String);

const userText = (message: ModelMessage | undefined) =>
  message?.role !== "user"
    ? ""
    : isString(message.content)
      ? message.content
      : (message.content ?? [])
          .flatMap((part) => (part.type === "text" ? [part.content] : []))
          .join("");

/**
 * Subagents answer once the test lets them, so a child ends after its parent's run and its report
 * arrives in a follow-up run, not in whichever parent step happens to come first.
 */
const children = { gate: Deferred.makeUnsafe<void>(), held: 0 };
export const childrenHeld = () => children.held;
export const releaseChildren = () => {
  Deferred.doneUnsafe(children.gate, Effect.void);
  children.gate = Deferred.makeUnsafe<void>();
  children.held = 0;
};
const childWaits = Effect.suspend(() => {
  children.held += 1;
  return Deferred.await(children.gate);
});

/**
 * The shared test model. Its call ids are fixed names (`call-reports`) that one conversation can
 * make more than once, so each carries the run that made it.
 */
const sharedModel: ScriptedResponder = (invocation) => {
  const scope = invocation.runId ?? invocation.threadId ?? "";
  const messages = invocation.messages.map((message) =>
    message.role === "tool" && message.toolCallId !== undefined
      ? { ...message, toolCallId: message.toolCallId.replace(/@.*$/, "") }
      : message,
  );
  const child = invocation.systemPrompts.some((prompt) => prompt.includes("You are a subagent"));
  return Promise.resolve(defaultTestResponder({ ...invocation, messages })).then((turn) => {
    const scoped =
      turn.toolCalls === undefined
        ? turn
        : {
            ...turn,
            toolCalls: turn.toolCalls.map((tool) => ({ ...tool, id: `${tool.id}@${scope}` })),
          };
    return child ? { ...scoped, waitFor: childWaits } : scoped;
  });
};

export const goldenResponder: ScriptedResponder = (invocation) => {
  const messages = invocation.messages;
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  const scenario = decodeScenario(/^golden:(\S+)$/.exec(userText(messages[lastUser]))?.[1]);
  if (Option.isNone(scenario)) return sharedModel(invocation);
  const step = messages
    .slice(lastUser + 1)
    .filter((message) => message.role === "assistant").length;
  // Model calls after the script, such as a follow-up for a child's report, go to the shared model.
  const script: ReadonlyArray<ScriptedTurn> = scripts[scenario.value];
  const turn = script[step];
  if (turn === undefined) return sharedModel(invocation);
  const sessionId = invocation.threadId ?? "";
  return turn.toolCalls === undefined
    ? turn
    : {
        ...turn,
        toolCalls: turn.toolCalls.map((tool) => ({
          ...tool,
          id: scopedCallId(tool.id, sessionId),
        })),
      };
};
