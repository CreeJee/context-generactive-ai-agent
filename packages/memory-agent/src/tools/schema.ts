import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import { JSONSchema, Schema } from "effect";

/** An Effect Schema exposed as the Standard JSON Schema that TanStack tool definitions consume. */
export type ToolSchema<A, I> = StandardSchemaV1<I, A> & StandardJSONSchemaV1<I, A>;

function jsonSchemaTarget(target: StandardJSONSchemaV1.Target) {
  switch (target) {
    case "draft-07":
      return "jsonSchema7";
    case "draft-2020-12":
      return "jsonSchema2020-12";
    default:
      throw new Error(`Unsupported JSON Schema target: ${target}`);
  }
}

/**
 * Effect 3 `Schema.standardSchemaV1` only validates. TanStack also needs `~standard.jsonSchema`
 * to describe tool inputs to the model, so this adds it from `JSONSchema.make`.
 */
export function toToolSchema<A, I>(schema: Schema.Schema<A, I, never>): ToolSchema<A, I> {
  const standard = Schema.standardSchemaV1(schema)["~standard"];
  return {
    "~standard": {
      version: 1,
      vendor: standard.vendor,
      validate: standard.validate,
      jsonSchema: {
        input: (options) => ({
          ...JSONSchema.make(schema, { target: jsonSchemaTarget(options.target) }),
        }),
        output: (options) => ({
          ...JSONSchema.make(Schema.typeSchema(schema), {
            target: jsonSchemaTarget(options.target),
          }),
        }),
      },
    },
  };
}
