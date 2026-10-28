import { it } from "@effect/vitest";
import { Effect, type JsonSchema, Option, Schema } from "effect";
import { describe, expect } from "vite-plus/test";
import { JsonValue } from "../../src/json.ts";
import { jsonSchemaIssues, prepareRepaired } from "../../src/tools/input-repair.ts";
import { runTool } from "../../src/tools/run-tool.ts";

const countItems = {
  name: "count_items",
  description: "Count items.",
  parameters: Schema.Struct({
    count: Schema.Int,
    exact: Schema.optionalKey(Schema.Boolean),
    label: Schema.optionalKey(Schema.String),
    mode: Schema.optionalKey(Schema.Literals(["fast", "slow"])),
    tags: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
} as const;

const refused = "refused";

const decodeArgs = Schema.decodeUnknownEffect(Schema.fromJsonString(JsonValue));

/** What the Effect AI tool's handler gets when the loop prepares `args`. */
const effectInput = (args: string) =>
  Effect.gen(function* () {
    const prepare = prepareRepaired(
      runTool({ ...countItems, handler: (input) => Effect.succeed(input) }),
    );
    return yield* Effect.flatMap(prepare(yield* decodeArgs(args)), (run) =>
      run({ toolCallId: "call-1" }),
    ).pipe(Effect.orElseSucceed((): JsonValue => refused));
  });

describe("tool input repair", () => {
  it("reports what does not fit a JSON Schema as TanStack did", () => {
    const counted = {
      type: "object",
      properties: { count: { type: "integer", minimum: 1 }, tags: { type: "array" } },
      required: ["count"],
      additionalProperties: false,
    };
    // Each schema and value with the issues TanStack's validator reported for them.
    const cases: ReadonlyArray<
      readonly [JsonSchema.JsonSchema, JsonValue, ReadonlyArray<string> | undefined]
    > = [
      [counted, { count: 2 }, undefined],
      [
        counted,
        { count: "2", extra: true },
        [
          '#/count: Instance type "string" is invalid. Expected "integer".',
          '#: Property "count" does not match additional properties schema.',
          "#/count: False boolean schema.",
          '#: Property "extra" does not match additional properties schema.',
          "#/extra: False boolean schema.",
        ],
      ],
      [
        counted,
        { tags: 1 },
        [
          '#: Instance does not have required property "count".',
          '#/tags: Instance type "number" is invalid. Expected "array".',
          '#: Property "tags" does not match additional properties schema.',
          "#/tags: False boolean schema.",
        ],
      ],
      [
        { type: "object", properties: { at: { $ref: "#/$defs/missing" } } },
        { at: 1 },
        ['Unresolved $ref "#/$defs/missing".'],
      ],
      [{ type: "string", nullable: true, minLength: 2 }, null, undefined],
    ];
    cases.forEach(([schema, value, issues]) => {
      expect(Option.getOrUndefined(jsonSchemaIssues({ schema, value }))).toEqual(issues);
    });
  });

  it.effect("repairs and refuses the arguments TanStack did", () =>
    Effect.gen(function* () {
      const cases = [
        '{"count":5}',
        '{"count":"5"}',
        '{"count":5,"exact":"true"}',
        '{"count":5,"label":null}',
        '{"count":5,"label":7}',
        '{"count":5,"mode":null}',
        '{"count":5,"tags":[1,true]}',
        '{"count":5,"extra":1}',
        '{"count":"5","extra":1}',
        '{"count":"five"}',
        '{"count":5.5}',
      ];
      // What TanStack handed the tool for each.
      expect(yield* Effect.forEach(cases, effectInput)).toEqual([
        { count: 5 },
        { count: 5 },
        { count: 5, exact: true },
        { count: 5 },
        { count: 5, label: "7" },
        { count: 5 },
        { count: 5, tags: ["1", "true"] },
        { count: 5 },
        refused,
        refused,
        refused,
      ]);
    }),
  );
});
