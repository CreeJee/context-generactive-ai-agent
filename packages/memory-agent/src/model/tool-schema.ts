import { type JsonSchema, Option, Schema } from "effect";
import { Tool } from "effect/ai";
import { optionalProperty } from "../optional-property.ts";
import { toolParametersJsonSchema } from "../tools/schema.ts";

/**
 * The JSON Schema a provider gets for a tool's parameters: the app's closed draft 2020-12 form of
 * the tool's Effect Schema (`tools/schema.ts`) without `$schema`, and an object schema always with
 * `properties` and `required`. A tool written in JSON Schema (MCP) goes as written.
 */
export const toolParameters = (tool: Tool.Any): JsonSchema.JsonSchema =>
  Option.liftPredicate(tool, Tool.isDynamic).pipe(
    Option.flatMapNullishOr((dynamic) => dynamic.jsonSchema),
    Option.getOrElse(() => fromSchema(tool)),
  );

/** Effect writes an empty `Schema.Struct({})` as "any value but null", which has no `type`. */
const isAnyNonNull = Schema.is(
  Schema.Struct({ not: Schema.Struct({ type: Schema.Literal("null") }) }),
);

const fromSchema = (tool: Tool.Any): JsonSchema.JsonSchema => {
  const { $schema: _, ...written } = toolParametersJsonSchema(tool.parametersSchema);
  // Anthropic refuses a tool whose input_schema has no `type` (`input_schema.type: Field required`).
  const { not: __, ...withoutNot } = written;
  const typed =
    written["type"] === undefined && isAnyNonNull(written)
      ? { ...withoutNot, type: "object", additionalProperties: false }
      : "properties" in written && written["type"] === undefined
        ? { ...written, type: "object" }
        : written;
  const object = typed["type"] === "object";
  return {
    ...typed,
    ...optionalProperty("properties", object && !("properties" in typed) ? {} : undefined),
    ...optionalProperty("required", object && !("required" in typed) ? [] : undefined),
  };
};
