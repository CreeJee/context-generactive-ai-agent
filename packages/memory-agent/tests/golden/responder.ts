import { Effect, Option, Schema } from "effect";
import type { ModelMessage } from "@tanstack/ai";
import type {
  ScriptedResponder,
  ScriptedToolCall,
  ScriptedTurn,
} from "../../src/testing/scripted-adapter.ts";
import type { JsonValue } from "../../src/json.ts";
import { scopedCallId, sessionScopedResponder } from "../support/chat-client.ts";

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

export const goldenResponder: ScriptedResponder = (invocation) => {
  const messages = invocation.messages;
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  const scenario = decodeScenario(/^golden:(\S+)$/.exec(userText(messages[lastUser]))?.[1]);
  if (Option.isNone(scenario)) return sessionScopedResponder(invocation);
  const step = messages
    .slice(lastUser + 1)
    .filter((message) => message.role === "assistant").length;
  const turn: ScriptedTurn = scripts[scenario.value][step] ?? {
    text: `${scenario.value} finished`,
  };
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
