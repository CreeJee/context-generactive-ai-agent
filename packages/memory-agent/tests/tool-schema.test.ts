import {
  convertSchemaToJsonSchema,
  toolDefinition,
  validateWithStandardSchema,
} from "@tanstack/ai";
import type { InferSchemaType } from "@tanstack/ai";
import { Schema } from "effect";
import { describe, expect, expectTypeOf, test } from "vite-plus/test";
import { toToolSchema } from "../src/tools/schema.ts";

// Mirrors a real memory tool: optional cursor, literal union, array, Korean descriptions.
const findMemoryInput = Schema.Struct({
  query: Schema.String.annotations({ description: "찾을 내용. 과거 발언과 다른 표현이어도 된다." }),
  kinds: Schema.Array(Schema.Literal("user", "assistant", "tool_call", "tool_result")).annotations({
    description: "검색할 노드 종류",
  }),
  cursor: Schema.optional(Schema.String),
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

  test("validates model arguments with Effect rules", async () => {
    await expect(
      validateWithStandardSchema(schema, { query: "저장소 결정", kinds: ["user"] }),
    ).resolves.toMatchObject({ success: true, data: { query: "저장소 결정", kinds: ["user"] } });
    await expect(
      validateWithStandardSchema(schema, { query: "저장소 결정", kinds: ["system"] }),
    ).resolves.toMatchObject({ success: false });
  });

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
      "Unsupported JSON Schema target",
    );
  });
});
