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

/** Model turns that wait until the test opens the gate, counting how many wait. */
const gate = () => {
  const state = { opened: Deferred.makeUnsafe<void>(), held: 0 };
  return {
    held: () => state.held,
    open: () => {
      Deferred.doneUnsafe(state.opened, Effect.void);
      state.opened = Deferred.makeUnsafe<void>();
      state.held = 0;
    },
    waits: Effect.suspend(() => {
      state.held += 1;
      return Deferred.await(state.opened);
    }),
  };
};

/**
 * Subagents answer once the test lets them, so a child ends after its parent's run and its report
 * arrives in a follow-up run, not in whichever parent step happens to come first.
 */
const children = gate();
export const childrenHeld = children.held;
export const releaseChildren = children.open;

/** A scripted turn that waits, so the test can act while the run is going. */
const turns = gate();
export const releaseTurns = turns.open;

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
  "goal-tools": [
    {
      toolCalls: [
        call("goal-read", "read_file", { path: "notes.txt" }),
        call("goal-list", "list_files", {}),
        call("goal-write", "write_file", { path: "goal.txt", content: "goal output\n" }),
      ],
    },
    { text: "goal tools done" },
  ],
  "goal-approval": [
    { toolCalls: [saveSkill("goal-approval", "printf goal-approved")] },
    { text: "goal approval done" },
  ],
  // The read waits, so a message queued meanwhile goes out when it returns. The queued message is
  // then the last user message, and the shared model answers it.
  queue: [
    { toolCalls: [call("queue-read", "read_file", { path: "notes.txt" })], waitFor: turns.waits },
  ],
  // A skill of its own, as the project already holds the skills of other scenarios.
  "hand-written": [
    { toolCalls: [saveSkill("hand-written", "printf hand-written")] },
    { text: "hand-written done" },
  ],
  // The model names a tool the run never offered.
  "unknown-tool": [
    { toolCalls: [call("unknown", "no_such_tool", { path: "notes.txt" })] },
    { text: "unknown tool done" },
  ],
  // Steering cuts this answer; the queued messages are the next turns.
  steer: [{ text: "never shown", waitFor: Effect.never }],
  // The skill still runs when the agent restarts, so its outcome is unknown.
  "goal-restart": [
    { toolCalls: [saveSkill("goal-sleeper", "sleep 3; printf slept")] },
    { toolCalls: [call("goal-run", "run_skill", { name: "goal-sleeper" })] },
    { text: "never reached" },
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
  "goal-tools",
  "goal-approval",
  "goal-restart",
  "queue",
  "steer",
  "unknown-tool",
  "hand-written",
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
    return child ? { ...scoped, waitFor: children.waits } : scoped;
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
