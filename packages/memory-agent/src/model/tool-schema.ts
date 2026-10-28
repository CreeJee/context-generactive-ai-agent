import { type JsonSchema, Option } from "effect";
import { Tool } from "effect/ai";
import { optionalProperty } from "../optional-property.ts";
import { toolParametersJsonSchema } from "../tools/schema.ts";

/**
 * The JSON Schema a provider gets for a tool's parameters, as TanStack sent it: the app's closed
 * draft-07 form of the tool's Effect Schema (`tools/schema.ts`) without `$schema`, and an object
 * schema always with `properties` and `required`. A tool written in JSON Schema (MCP) goes as
 * written.
 */
export const toolParameters = (tool: Tool.Any): JsonSchema.JsonSchema =>
  Option.liftPredicate(tool, Tool.isDynamic).pipe(
    Option.flatMapNullishOr((dynamic) => dynamic.jsonSchema),
    Option.getOrElse(() => fromSchema(tool)),
  );

const fromSchema = (tool: Tool.Any): JsonSchema.JsonSchema => {
  const { $schema: _, ...written } = toolParametersJsonSchema(tool.parametersSchema);
  const typed =
    "properties" in written && written["type"] === undefined
      ? { ...written, type: "object" }
      : written;
  const object = typed["type"] === "object";
  return {
    ...typed,
    ...optionalProperty("properties", object && !("properties" in typed) ? {} : undefined),
    ...optionalProperty("required", object && !("required" in typed) ? [] : undefined),
  };
};
