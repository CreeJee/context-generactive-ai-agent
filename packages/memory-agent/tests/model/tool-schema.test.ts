import { it } from "@effect/vitest";
import { toolDefinition } from "@tanstack/ai";
import { Effect, Schema } from "effect";
import { describe, expect } from "vite-plus/test";
import {
  RunSkillInput,
  SaveCodeSkillInput,
  WriteOutsideFileInput,
} from "../../src/tools/definitions.ts";
import { runTool } from "../../src/tools/run-tool.ts";
import { toToolSchema } from "../../src/tools/schema.ts";
import {
  compatibleToolRequestDifference,
  matchGolden,
  toolRequestBodies,
  toolRequestDifferences,
} from "../support/requests.ts";

/**
 * A tool written with an Effect Schema reaches every provider with the parameters TanStack sent
 * for it (docs/effect-ai-migration.md step 3): bounds folded out of `allOf`, closed objects,
 * unions, records and optional fields.
 */

const cases = [
  { name: "save_code_skill", description: "Save a skill.", parameters: SaveCodeSkillInput },
  { name: "run_skill", description: "Run a skill.", parameters: RunSkillInput },
  { name: "write_outside_file", description: "Write a file.", parameters: WriteOutsideFileInput },
  {
    name: "list_files",
    description: "List files.",
    parameters: Schema.Struct({
      directory: Schema.optionalKey(Schema.String.annotate({ description: "Where." })),
      offset: Schema.optionalKey(Schema.Int),
      order: Schema.Literals(["name", "time"]),
    }),
  },
  { name: "list_tasks", description: "List tasks.", parameters: Schema.Struct({}) },
];

const chatTools = () =>
  cases.map(({ name, description, parameters }) =>
    toolDefinition({ name, description, inputSchema: toToolSchema(parameters) }),
  );
const modelTools = cases.map(
  (definition) => runTool({ ...definition, handler: () => Effect.void }).tool,
);

describe("tool parameters", () => {
  it.effect("are what TanStack sent each provider", () =>
    Effect.gen(function* () {
      expect(yield* toolRequestDifferences({ chatTools: chatTools(), modelTools })).toEqual([
        { provider: "anthropic", difference: undefined },
        { provider: "openai", difference: undefined },
      ]);
      expect(
        yield* compatibleToolRequestDifference({ chatTools: chatTools(), modelTools }),
      ).toBeUndefined();
    }),
  );

  it.effect("are in the golden requests", () =>
    Effect.flatMap(toolRequestBodies(modelTools), matchGolden("./__golden__/tool-schema.json")),
  );
});
