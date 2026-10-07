import { it } from "@effect/vitest";
import {
  convertSchemaToJsonSchema,
  toolDefinition,
  validateWithStandardSchema,
} from "@tanstack/ai";
import type { InferSchemaType } from "@tanstack/ai";
import { Effect, Schema } from "effect";
import { describe, expect, expectTypeOf, test } from "vite-plus/test";
import { toToolSchema } from "../src/tools/schema.ts";

// Mirrors a real memory tool: optional cursor, literal union, array, Korean descriptions.
const findMemoryInput = Schema.Struct({
  query: Schema.String.annotate({ description: "찾을 내용. 과거 발언과 다른 표현이어도 된다." }),
  kinds: Schema.Array(Schema.Literals(["user", "assistant", "tool_call", "tool_result"])).annotate({
    description: "검색할 노드 종류",
  }),
  cursor: Schema.optionalKey(Schema.String),
});

describe("toToolSchema", () => {
  const schema = toToolSchema(findMemoryInput);

  test("describes tool input to the model with descriptions intact", () => {
    const json = convertSchemaToJsonSchema(schema);
    expect(json).toMatchObject({
      type: "object",
      required: ["query", "kinds"],
      properties: {
        query: { type: "string", description: "찾을 내용. 과거 발언과 다른 표현이어도 된다." },
        kinds: {
          type: "array",
          description: "검색할 노드 종류",
          items: { enum: ["user", "assistant", "tool_call", "tool_result"] },
        },
        cursor: { type: "string" },
      },
    });
  });

  test("survives strict structured-output conversion", () => {
    const json = convertSchemaToJsonSchema(schema, { forStructuredOutput: true });
    expect(json).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: expect.arrayContaining(["query", "kinds", "cursor"]),
    });
  });

  it.effect("validates model arguments with Effect rules", () =>
    Effect.gen(function* () {
      expect(
        yield* Effect.promise(() =>
          validateWithStandardSchema(schema, { query: "저장소 결정", kinds: ["user"] }),
        ),
      ).toMatchObject({ success: true, data: { query: "저장소 결정", kinds: ["user"] } });
      expect(
        yield* Effect.promise(() =>
          validateWithStandardSchema(schema, { query: "저장소 결정", kinds: ["system"] }),
        ),
      ).toMatchObject({ success: false });
    }),
  );

  test("keeps TanStack tool argument inference", () => {
    const tool = toolDefinition({
      name: "find_memory",
      description: "Find prior messages",
      inputSchema: schema,
    });
    expectTypeOf<InferSchemaType<typeof tool.inputSchema>>().toEqualTypeOf<{
      readonly query: string;
      readonly kinds: readonly ("user" | "assistant" | "tool_call" | "tool_result")[];
      readonly cursor?: string;
    }>();
  });

  test("rejects JSON Schema targets Effect cannot produce", () => {
    expect(() => schema["~standard"].jsonSchema.input({ target: "openapi-3.0" })).toThrow(
      "Unsupported target",
    );
  });
});
