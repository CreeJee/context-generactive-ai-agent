import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import {
  Array as EffectArray,
  Function as EffectFunction,
  JsonSchema,
  Option,
  Predicate,
  Record as EffectRecord,
  Result,
  Schema,
} from "effect";
import { JsonValue } from "../json.ts";
import { optionalProperty } from "../optional-property.ts";

/** An Effect Schema exposed as the Standard JSON Schema that TanStack tool definitions consume. */
export type ToolSchema<A, I> = StandardSchemaV1<I, A> & StandardJSONSchemaV1<I, A>;

/**
 * The bounds Effect moves into `allOf` when a check repeats a keyword its base already set (every
 * `Schema.Int` carries the safe-integer range), each with how two of them intersect.
 */
const BoundKeyword = Schema.Literals([
  "minimum",
  "exclusiveMinimum",
  "minLength",
  "minItems",
  "minProperties",
  "maximum",
  "exclusiveMaximum",
  "maxLength",
  "maxItems",
  "maxProperties",
]);
const isBoundKeyword = Schema.is(BoundKeyword);
const boundIntersection = {
  minimum: Math.max,
  exclusiveMinimum: Math.max,
  minLength: Math.max,
  minItems: Math.max,
  minProperties: Math.max,
  maximum: Math.min,
  exclusiveMaximum: Math.min,
  maxLength: Math.min,
  maxItems: Math.min,
  maxProperties: Math.min,
} satisfies Record<typeof BoundKeyword.Type, (left: number, right: number) => number>;
/** Annotations Effect puts in the same member when `.annotate()` follows the repeating check. */
const isAnnotationKeyword = Schema.is(Schema.Literals(["title", "description"]));
/** Keywords whose values are instance data, never schemas to normalize. */
const isDataKeyword = Schema.is(Schema.Literals(["const", "enum", "default", "examples"]));

type JsonObject = Extract<JsonValue, { readonly [key: string]: JsonValue }>;
const isJsonArray = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value);
const isJsonObject = (value: JsonValue): value is JsonObject => Predicate.isObject(value);
// Synchronous codec at the Standard JSON Schema boundary; Effect's document is JSON by construction.
const toJsonObject = EffectFunction.flow(
  Schema.decodeUnknownResult(Schema.Record(Schema.String, JsonValue)),
  Result.getOrThrow,
);

type Fold = (node: JsonObject) => JsonObject;
/**
 * How one keyword of an `allOf` member folds into its node: a bound intersects the node's, and the
 * member's annotation, the more specific one, replaces the node's. Other keywords do not fold.
 */
const keywordFold = (key: string, value: JsonValue): Option.Option<Fold> => {
  if (isBoundKeyword(key) && Predicate.isNumber(value))
    return Option.some((node) => {
      const current = node[key];
      return {
        ...node,
        [key]: Predicate.isNumber(current) ? boundIntersection[key](current, value) : value,
      };
    });
  if (isAnnotationKeyword(key) && Predicate.isString(value))
    return Option.some((node) => ({ ...node, [key]: value }));
  return Option.none();
};
/** How an `allOf` member folds into its node, when every keyword it has folds. */
const memberFold = (member: JsonValue): Option.Option<Fold> =>
  Option.liftPredicate(isJsonObject)(member).pipe(
    Option.flatMap((fields) =>
      Option.all(Object.entries(fields).map(([key, value]) => keywordFold(key, value))),
    ),
    Option.map((folds) => (node) => folds.reduce((out, fold) => fold(out), node)),
  );

const foldValue = (value: JsonValue): JsonValue =>
  isJsonArray(value) ? value.map(foldValue) : isJsonObject(value) ? foldNode(value) : value;

/**
 * Folds the `allOf` members that only bound and annotate into their node, so the same instances
 * pass. OpenAI strict tools reject `allOf`; an unfolded bound sends the tool non-strict.
 */
const foldNode = (node: JsonObject): JsonObject => {
  const { allOf, ...rest } = EffectRecord.map(node, (child, key) =>
    isDataKeyword(key) ? child : foldValue(child),
  );
  if (allOf === undefined || !isJsonArray(allOf)) return rest;
  const [folds, kept] = EffectArray.partition(allOf, (member) =>
    Option.match(memberFold(member), {
      onNone: () => Result.fail(member),
      onSome: Result.succeed,
    }),
  );
  const folded = folds.reduce((out, fold) => fold(out), rest);
  return kept.length === 0 ? folded : { ...folded, allOf: kept };
};

/**
 * The tool's JSON Schema with closed objects, which OpenAI strict tools require (an open one sends
 * the tool non-strict). Decoding still drops unmodeled properties instead of rejecting them.
 */
const toolJsonSchema = (
  schema: Schema.Constraint,
  target: StandardJSONSchemaV1.Target,
): JsonObject => {
  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" });
  const shared = (definitions: JsonSchema.Definitions) =>
    Object.keys(definitions).length > 0 ? definitions : undefined;
  if (target === "draft-2020-12")
    return foldNode(
      toJsonObject({
        ...document.schema,
        ...optionalProperty("$defs", shared(document.definitions)),
      }),
    );
  if (target === "draft-07") {
    const draft07 = JsonSchema.toDocumentDraft07(document);
    return foldNode(
      toJsonObject({
        ...draft07.schema,
        ...optionalProperty("definitions", shared(draft07.definitions)),
      }),
    );
  }
  // The Standard Schema caller reads JSON Schema synchronously; this is its thrown error.
  throw new Error(`Unsupported target: ${target}`);
};

/** A tool's parameters in the draft-07 form TanStack sends providers. */
export const toolParametersJsonSchema = (schema: Schema.Constraint) =>
  toolJsonSchema(schema, "draft-07");

export const toToolSchema = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
): ToolSchema<S["Type"], S["Encoded"]> => ({
  "~standard": {
    ...Schema.toStandardSchemaV1(schema)["~standard"],
    jsonSchema: {
      input: ({ target }) => toolJsonSchema(schema, target),
      output: ({ target }) => toolJsonSchema(Schema.toType(schema), target),
    },
  },
});
