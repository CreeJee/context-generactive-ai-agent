import { DISCOVERY_TOOL_NAME, type ModelMessage } from "@tanstack/ai";
import { Effect, FileSystem, Path, Schema } from "effect";
import { expect } from "vite-plus/test";
import { Nodes } from "../src/memory/nodes.ts";
import type { ScriptedResponder } from "../src/testing/scripted-adapter.ts";
import { runTurn, toolResults } from "./support/chat-client.ts";
import { selectTestModel } from "./support/provider.ts";
import { freshSession, TestEnv, testAgent } from "./support/test-env.ts";

const textOf = (message: ModelMessage | undefined) =>
  Schema.is(Schema.String)(message?.content)
    ? message.content
    : (message?.content ?? [])
        .flatMap((part) => (part.type === "text" ? [part.content] : []))
        .join("");

/** Asks for read_outside_file, reads the file the user names, then answers with its text. */
const responder: ScriptedResponder = (invocation) => {
  const results = invocation.messages.filter((message) => message.role === "tool");
  const path = /(\/\S+\.txt)/.exec(textOf(invocation.messages.findLast((m) => m.role === "user")));
  if (results.length === 0)
    return {
      toolCalls: [
        {
          id: "call-discover",
          name: DISCOVERY_TOOL_NAME,
          arguments: JSON.stringify({ toolNames: ["read_outside_file"] }),
        },
      ],
    };
  if (results.length === 1)
    return {
      toolCalls: [
        {
          id: "call-read",
          name: "read_outside_file",
          arguments: JSON.stringify({ path: path?.[1] }),
        },
      ],
    };
  return { text: `read: ${textOf(results.at(-1))}` };
};

testAgent({ testProvider: { responder } })("lazy tools", (it) => {
  it.effect("an outside tool is sent by name until the model asks for it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { base, provider } = yield* TestEnv;
      const file = path.join(base, "outside.txt");
      yield* fs.writeFileString(file, "OUTSIDE CONTENT\n");
      yield* selectTestModel();
      const session = yield* freshSession;
      const events = yield* runTurn(session, `${session}:read`, `read ${file}`);
      const invocations = (provider?.adapter.invocations ?? []).filter(
        (invocation) => invocation.threadId === session,
      );
      expect(invocations[0]?.toolNames).toContain(DISCOVERY_TOOL_NAME);
      expect(invocations[0]?.toolNames).not.toContain("read_outside_file");
      expect(invocations[1]?.toolNames).toContain("read_outside_file");
      expect(toolResults(events).join("\n")).toContain("OUTSIDE CONTENT");
      // Asking for a tool is not work the memory keeps.
      const calls = (yield* (yield* Nodes).session(session)).filter(
        (node) => node.kind === "tool_call",
      );
      expect(calls.map((node) => node.detail.toolName)).toEqual(["read_outside_file"]);
    }),
  );
});
