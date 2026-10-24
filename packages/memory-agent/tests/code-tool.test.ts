import { layer } from "@effect/vitest";
import { toolDefinition, type AnyServerTool } from "@tanstack/ai";
import { Effect, HashSet, Schema } from "effect";
import { expect } from "vite-plus/test";
import { CodeTools } from "../src/tools/code.ts";
import { ToolFailed } from "../src/tools/failure.ts";
import { toToolSchema } from "../src/tools/schema.ts";
import { isTruthy } from "../src/truthy.ts";

const plain = (name: string, needsApproval = false) =>
  toolDefinition({
    name,
    description: name,
    inputSchema: toToolSchema(Schema.Struct({ text: Schema.String })),
    needsApproval,
  }).server(({ text }, context) => ({ text, id: context?.toolCallId }));

const tools: AnyServerTool[] = [
  plain("echo_text"),
  // Asks in this run: named by the gate, or held by TanStack's own approval.
  plain("write_outside_file"),
  plain("approve_me", true),
  // Steers the run itself.
  plain("update_plan"),
  // Not an identifier as `external_<name>`.
  plain("mcp_files__read-all"),
  toolDefinition({
    name: "read_file",
    description: "read_file",
    inputSchema: toToolSchema(Schema.Struct({ path: Schema.String })),
  }).server(({ path }) =>
    Promise.reject(ToolFailed.make({ code: "not_found", tag: "PathRejected", detail: path })),
  ),
];

layer(CodeTools.layer, { excludeTestServices: true })("run_code", (it) => {
  it.effect("a program calls the run's tools, but none that ask or steer the run", () =>
    Effect.gen(function* () {
      const runCode = yield* (yield* CodeTools).forTools(tools, HashSet.make("write_outside_file"));
      expect(runCode.description).toContain("Available: external_echo_text, external_read_file.");
      const execute = runCode.execute;
      if (!isTruthy(execute)) throw new Error("run_code has no server side");
      const result = yield* Effect.promise(() =>
        Promise.resolve(
          execute(
            {
              code: `
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
              `,
            },
            { toolCallId: "call-1", emitCustomEvent: () => undefined },
          ),
        ),
      );
      expect(result).toEqual({
        status: "returned",
        value: {
          echoed: { text: "hi", id: "call-1#1" },
          invalid: true,
          failed: "not_found: a.txt",
          hidden: ["undefined", "undefined", "undefined"],
        },
        logs: [],
      });
    }),
  );
});
