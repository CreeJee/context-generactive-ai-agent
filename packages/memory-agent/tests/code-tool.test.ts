import { Effect, HashSet, Schema } from "effect";
import { expect } from "vite-plus/test";
import { CodeTools } from "../src/tools/code.ts";
import { ToolFailed } from "../src/tools/failure.ts";
import { runTool } from "../src/tools/run-tool.ts";
import { callTool } from "./support/run-tools.ts";
import { testAgent } from "./support/test-env.ts";

const plain = (name: string, needsApproval = false) =>
  runTool({
    name,
    description: name,
    parameters: Schema.Struct({ text: Schema.String }),
    needsApproval,
    handler: ({ text }, call) => Effect.succeed({ text, id: call.toolCallId }),
  });

const tools = [
  plain("echo_text"),
  // Asks in this run: named by the gate, or held by its own approval.
  plain("write_outside_file"),
  plain("approve_me", true),
  // Steers the run itself.
  plain("update_plan"),
  // Not an identifier as `external_<name>`.
  plain("mcp_files__read-all"),
  runTool({
    name: "read_file",
    description: "read_file",
    parameters: Schema.Struct({ path: Schema.String }),
    handler: ({ path }) =>
      Effect.fail(ToolFailed.make({ code: "not_found", tag: "PathRejected", detail: path })),
  }),
];

const program = `
  const echoed = await external_echo_text({ text: "hi" });
  const invalid = await external_echo_text({ text: 1 }).catch((error) => error.message);
  const failed = await external_read_file({ path: "a.txt" }).catch((error) => error.message);
  return {
    echoed,
    invalid: invalid.startsWith("invalid_input: "),
    failed,
    hidden: [
      typeof external_write_outside_file,
      typeof external_approve_me,
      typeof external_update_plan,
    ],
  };
`;

testAgent()("run_code", (it) => {
  it.effect("a program calls the run's tools, but none that ask or steer the run", () =>
    Effect.gen(function* () {
      const { runCode } = (yield* CodeTools).forRunTools(tools, HashSet.make("write_outside_file"));
      expect(runCode.tool.description).toContain(
        "Available: external_echo_text, external_read_file.",
      );
      expect(yield* callTool([runCode], "run_code", { code: program })).toEqual({
        status: "returned",
        value: {
          echoed: { text: "hi", id: "call-run_code#1" },
          invalid: true,
          failed: "not_found: a.txt",
          hidden: ["undefined", "undefined", "undefined"],
        },
        logs: [],
      });
    }),
  );
});
