import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import { Schema } from "effect";

/** An Effect Schema exposed as the Standard JSON Schema that TanStack tool definitions consume. */
export type ToolSchema<A, I> = StandardSchemaV1<I, A> & StandardJSONSchemaV1<I, A>;

export const toToolSchema = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
): ToolSchema<S["Type"], S["Encoded"]> => ({
  "~standard": {
    ...Schema.toStandardSchemaV1(schema)["~standard"],
    ...Schema.toStandardJSONSchemaV1(schema)["~standard"],
  },
});
