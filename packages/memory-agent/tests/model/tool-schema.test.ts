import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe } from "vite-plus/test";
import {
  RunSkillInput,
  SaveCodeSkillInput,
  WriteOutsideFileInput,
} from "../../src/tools/definitions.ts";
import { NotifySessionInput } from "../../src/sessions/dispatches.ts";
import { runTool } from "../../src/tools/run-tool.ts";
import { matchGolden, toolRequestBodies } from "../support/requests.ts";

/**
 * A tool written with an Effect Schema reaches every provider with the draft 2020-12 parameters
 * Effect writes for it, as the golden requests keep them: bounds folded out of `allOf`, closed
 * objects, unions, records, optional fields and non-empty arrays.
 */

const cases = [
  { name: "save_code_skill", description: "Save a skill.", parameters: SaveCodeSkillInput },
  { name: "run_skill", description: "Run a skill.", parameters: RunSkillInput },
  { name: "write_outside_file", description: "Write a file.", parameters: WriteOutsideFileInput },
  {
    name: "notify_session",
    description: "Notify another session.",
    parameters: NotifySessionInput,
  },
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
  // Draft 2020-12 `prefixItems`, not draft-07's array `items`, which Anthropic refuses.
  {
    name: "tag_files",
    description: "Tag files.",
    parameters: Schema.Struct({ tags: Schema.NonEmptyArray(Schema.String) }),
  },
];

const modelTools = cases.map(
  (definition) => runTool({ ...definition, handler: () => Effect.void }).tool,
);

describe("tool parameters", () => {
  it.effect("are what each provider gets", () =>
    Effect.flatMap(toolRequestBodies(modelTools), matchGolden("./__golden__/tool-schema.json")),
  );
});
