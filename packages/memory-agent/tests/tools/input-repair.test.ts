import { it } from "@effect/vitest";
import { chat, toolDefinition } from "@tanstack/ai";
import { Cause, Effect, Schema } from "effect";
import { describe, expect } from "vite-plus/test";
import { JsonValue } from "../../src/json.ts";
import { ScriptedTextAdapter } from "../../src/testing/scripted-adapter.ts";
import { prepareRepaired } from "../../src/tools/input-repair.ts";
import { runTool } from "../../src/tools/run-tool.ts";
import { definitionOf } from "../../src/tools/schema.ts";

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

/** What TanStack handed the tool when the model sent `args`. */
const tanstackInput = (args: string) =>
  Effect.gen(function* () {
    let received: JsonValue = refused;
    const tool = toolDefinition(definitionOf(countItems)).server((input) => {
      received = input;
      return "ok";
    });
    yield* Effect.tryPromise({
      try: () =>
        chat({
          threadId: "thread",
          adapter: new ScriptedTextAdapter([
            { toolCalls: [{ id: "call-1", name: countItems.name, arguments: args }] },
            { text: "done" },
          ]),
          messages: [{ role: "user", content: "count" }],
          tools: [tool],
          stream: false,
        }),
      catch: (cause) => new Cause.UnknownError(cause),
    });
    return received;
  });

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
  it.live("repairs and refuses the arguments TanStack did", () =>
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
      const tanstack = yield* Effect.forEach(cases, tanstackInput);
      expect(yield* Effect.forEach(cases, effectInput)).toEqual(tanstack);
      expect(tanstack).toEqual([
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
