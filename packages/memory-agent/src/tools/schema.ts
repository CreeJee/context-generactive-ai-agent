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
// Synchronous codec where requests read tool parameters; Effect's document is JSON by construction.
const toJsonObject = EffectFunction.flow(
  Schema.decodeUnknownResult(Schema.Record(Schema.String, JsonValue)),
  Result.getOrThrow,
);

type Fold = (node: JsonObject) => JsonObject;
/**
 * How one keyword of an `allOf` member folds into its node: a bound intersects the node's, and the
 * member's annotation, the more specific one, replaces the node's. Other keywords do not fold.
 */
const keywordFold = (key: string, value: JsonValue): Option.Option<Fold> =>
  Option.zipWith(
    Option.liftPredicate(key, isBoundKeyword),
    Option.liftPredicate(value, Predicate.isNumber),
    (bound, limit): Fold =>
      (node) => {
        const current = node[bound];
        return {
          ...node,
          [bound]: Predicate.isNumber(current) ? boundIntersection[bound](current, limit) : limit,
        };
      },
  ).pipe(
    Option.orElse(() =>
      Option.zipWith(
        Option.liftPredicate(key, isAnnotationKeyword),
        Option.liftPredicate(value, Predicate.isString),
        (annotation, text): Fold =>
          (node) => ({ ...node, [annotation]: text }),
      ),
    ),
  );
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
  return Option.fromNullishOr(allOf).pipe(
    Option.filter(isJsonArray),
    Option.match({
      onNone: () => rest,
      onSome: (members) => {
        const [folds, kept] = EffectArray.partition(members, (member) =>
          Option.match(memberFold(member), {
            onNone: () => Result.fail(member),
            onSome: Result.succeed,
          }),
        );
        const folded = folds.reduce((out, fold) => fold(out), rest);
        return kept.length === 0 ? folded : { ...folded, allOf: kept };
      },
    }),
  );
};

/**
 * A tool's parameters in the draft-07 form TanStack sent providers, with closed objects, which
 * OpenAI strict tools require (an open one sends the tool non-strict). Decoding still drops
 * unmodeled properties instead of rejecting them.
 */
export const toolParametersJsonSchema = (schema: Schema.Constraint): JsonObject => {
  const draft07 = JsonSchema.toDocumentDraft07(
    Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" }),
  );
  return foldNode(
    toJsonObject({
      ...draft07.schema,
      ...optionalProperty(
        "definitions",
        Object.keys(draft07.definitions).length > 0 ? draft07.definitions : undefined,
      ),
    }),
  );
};
