import {
  deepCompareStrict,
  dereference,
  initialBaseURI,
  validate,
  type Schema as JsonSchemaNode,
  type SchemaDraft,
} from "@cfworker/json-schema";
import {
  Array as Arr,
  Effect,
  Function as EffectFunction,
  type JsonSchema,
  Match,
  Option,
  Predicate,
  Record as EffectRecord,
  Result,
  Schema,
} from "effect";
import { JsonValue } from "../json.ts";
import { toolParameters } from "../model/tool-schema.ts";
import { optionalProperty } from "../optional-property.ts";
import type { RunTool } from "./run-tool.ts";

/**
 * TanStack's checks of tool input against JSON Schema (`@tanstack/ai` input-validation), which the
 * app keeps now that the loop decodes calls itself (docs/effect-ai-migration.md step 3), with the
 * same validator. Arguments that fail the tool's schema are converted toward the JSON Schema the
 * model was sent: `"5"` for 5, `"true"` for true, `null` for an optional field left out. They are
 * decoded again only when that makes them fit; otherwise the first failure is what the model reads.
 */

type JsonObject = Extract<JsonValue, { readonly [key: string]: JsonValue }>;
type Node = JsonSchemaNode | boolean;
const isJsonArray = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value);
const isJsonObject = (value: JsonValue): value is JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);
// Synchronous codec at the JSON Schema boundary; a tool's JSON Schema is JSON by construction.
const toJsonObject = EffectFunction.flow(
  Schema.decodeUnknownResult(Schema.Record(Schema.String, JsonValue)),
  Result.getOrThrow,
);

/** Keywords whose value is data, not a schema. */
const isDataKeyword = Schema.is(
  Schema.Literals(["const", "enum", "default", "examples", "example"]),
);
/** Keywords whose value maps names to schemas. */
const isSchemaMapKeyword = Schema.is(
  Schema.Literals([
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
    "dependentSchemas",
    "dependencies",
  ]),
);
/** Draft-04 and OpenAPI 3.0 write these bounds as booleans. */
const booleanBounds = [
  ["exclusiveMinimum", "minimum"],
  ["exclusiveMaximum", "maximum"],
] as const;
/** Keywords that can reject `null` even when `type` allows it. */
const nullRejectingKeywords = ["$ref", "allOf", "anyOf", "oneOf", "not"] as const;
/** Keywords that name a schema. They stay on a wrapped schema. */
const isNamingKeyword = Schema.is(Schema.Literals(["$id", "id", "$schema", "$anchor"]));

/** A key as a JSON Pointer token, URI-encoded as cfworker stores paths. */
const pointerToken = (key: string) => encodeURI(key.replaceAll("~", "~0").replaceAll("/", "~1"));

/** A node made ready for the validator, and the paths of the schemas wrapped in it, inner first. */
interface Ready {
  readonly node: JsonValue;
  readonly wrapped: ReadonlyArray<string>;
}

/** A ready object: a schema, or a map of schemas. */
interface ReadyObject extends Ready {
  readonly node: JsonObject;
}

/** Ready nodes under their keys as one node, with what they wrapped in key order. */
const readyRecord = (ready: Readonly<Record<string, Ready>>): ReadyObject => ({
  node: EffectRecord.map(ready, (entry) => entry.node),
  wrapped: Object.values(ready).flatMap((entry) => entry.wrapped),
});

/** `nullable: true` on a schema already bounded: see {@link preparedSchema}. */
const nullableSchema = (bounded: JsonObject, path: string): Ready => {
  const type = bounded["type"];
  const values = bounded["enum"];
  const nullable: JsonObject = {
    ...bounded,
    ...optionalProperty(
      "type",
      type === undefined ? undefined : [...new Set([type, "null"].flat())],
    ),
    ...optionalProperty(
      "enum",
      isJsonArray(values) && !values.includes(null) ? [...values, null] : undefined,
    ),
  };
  return nullRejectingKeywords.some((key) => key in nullable)
    ? {
        node: {
          ...EffectRecord.filter(nullable, (_, key) => isNamingKeyword(key)),
          if: { type: "null" },
          else: EffectRecord.filter(nullable, (_, key) => !isNamingKeyword(key)),
        },
        wrapped: [path],
      }
    : { node: nullable, wrapped: [] };
};

/**
 * One schema made ready for the validator:
 * - `format` goes away. It is an annotation, as in 2019-09 and later.
 * - A boolean bound becomes the number form, so it works in every draft.
 * - OpenAPI 3.0 `nullable: true` lets the value be `null`: `null` joins `type` and `enum`. A schema
 *   with a keyword that can still reject `null` becomes `{ if: { type: 'null' }, else: schema }`,
 *   and its path is wrapped.
 */
const preparedSchema = (schema: JsonObject, path: string): Ready => {
  const { format, ...withoutFormat } = schema;
  const bounded = booleanBounds.reduce<JsonObject>(
    (node, [bound, limit]) =>
      Option.match(Option.liftPredicate(node[bound], Predicate.isBoolean), {
        onNone: () => node,
        onSome: (flag) => {
          const { [bound]: _, [limit]: limitValue, ...rest } = node;
          // A true flag makes the limit the bound; a false one leaves the limit as it is.
          return Option.match(Option.fromUndefinedOr(limitValue), {
            onNone: () => rest,
            onSome: (value) =>
              flag && Predicate.isNumber(value)
                ? { ...rest, [bound]: value }
                : { ...rest, [limit]: value },
          });
        },
      }),
    Predicate.isString(format) ? withoutFormat : schema,
  );
  return bounded["nullable"] === true
    ? nullableSchema(bounded, path)
    : { node: bounded, wrapped: [] };
};

/** A keyword's value made ready: data stays, a map of schemas readies each schema. */
const preparedKeyword = (value: JsonValue, key: string, path: string): Ready => {
  const keyPath = `${path}/${pointerToken(key)}`;
  return isDataKeyword(key)
    ? { node: value, wrapped: [] }
    : Option.match(
        Option.filter(Option.liftPredicate(value, isJsonObject), () => isSchemaMapKeyword(key)),
        {
          onSome: (schemas) =>
            readyRecord(
              EffectRecord.map(schemas, (schema, name) =>
                prepared(schema, `${keyPath}/${pointerToken(name)}`),
              ),
            ),
          onNone: () => prepared(value, keyPath),
        },
      );
};

/** `node` with each schema in it made ready for the validator, inner schemas first. */
const prepared = (node: JsonValue, path: string): Ready =>
  Match.value(node).pipe(
    Match.when(isJsonArray, (items): Ready => {
      const ready = items.map((item, index) => prepared(item, `${path}/${index}`));
      return {
        node: ready.map((entry) => entry.node),
        wrapped: ready.flatMap((entry) => entry.wrapped),
      };
    }),
    Match.when(isJsonObject, (object): Ready => {
      const children = readyRecord(
        EffectRecord.map(object, (value, key) => preparedKeyword(value, key, path)),
      );
      const own = preparedSchema(children.node, path);
      return { node: own.node, wrapped: [...children.wrapped, ...own.wrapped] };
    }),
    Match.orElse((leaf): Ready => ({ node: leaf, wrapped: [] })),
  );

/** Any base works. A ref resolves as a URL, as cfworker reads it. */
const refBase = "https://ref.invalid/";
/** A `$ref` into a wrapped schema, moved to where that schema went. */
const movedRef = (ref: string, wrappedPath: string) => {
  const moved = () => {
    const target = new URL(ref, refBase).href;
    const from = new URL(wrappedPath, refBase).href;
    return target.startsWith(`${from}/`)
      ? `${from}/else${target.slice(from.length)}`.slice(refBase.length)
      : ref;
  };
  return ref.startsWith("#") ? moved() : ref;
};
const withMovedRefs = (node: JsonValue, wrapped: ReadonlyArray<string>): JsonValue =>
  Match.value(node).pipe(
    Match.when(isJsonArray, (items): JsonValue =>
      items.map((item) => withMovedRefs(item, wrapped)),
    ),
    Match.when(isJsonObject, (object): JsonValue =>
      EffectRecord.map(object, (value, key) =>
        isDataKeyword(key)
          ? value
          : key === "$ref" && Predicate.isString(value)
            ? wrapped.reduce(movedRef, value)
            : withMovedRefs(value, wrapped),
      ),
    ),
    Match.orElse((leaf) => leaf),
  );

/** The draft named by `$schema`, else 2020-12. */
const draftOf = (schema: JsonObject): SchemaDraft =>
  Match.value(Predicate.isString(schema["$schema"]) ? schema["$schema"] : "").pipe(
    Match.when(
      (uri) => /draft-0[467]/.test(uri),
      (): SchemaDraft => "7",
    ),
    Match.when(
      (uri) => uri.includes("2019-09"),
      (): SchemaDraft => "2019-09",
    ),
    Match.orElse((): SchemaDraft => "2020-12"),
  );

interface Compiled {
  readonly schema: JsonSchemaNode;
  readonly draft: SchemaDraft;
  readonly lookup: Record<string, Node>;
}

const compile = (schema: JsonObject): Compiled => {
  const { node: ready, wrapped } = prepared(schema, "#");
  // cfworker marks resolved refs on the schema it is given, so it gets this copy.
  const copy: JsonSchemaNode = toJsonObject(
    wrapped.length > 0 ? withMovedRefs(ready, wrapped) : ready,
  );
  return { schema: copy, draft: draftOf(schema), lookup: dereference(copy) };
};

const decimal = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const isDecimal = (value: JsonValue): value is string =>
  Predicate.isString(value) && decimal.test(value);
const toNumber = (value: JsonValue, type: "number" | "integer"): JsonValue =>
  Match.value(value).pipe(
    Match.when(Match.null, () => 0),
    Match.when(Predicate.isBoolean, (flag) => (flag ? 1 : 0)),
    Match.when(isDecimal, (text) => {
      const number = Number(text);
      return (type === "integer" ? Number.isSafeInteger(number) : Number.isFinite(number))
        ? number
        : text;
    }),
    Match.orElse(() => value),
  );
const convertPrimitive = (value: JsonValue, type: string): JsonValue =>
  Match.value(type).pipe(
    Match.when(Match.is("number", "integer"), (numeric) => toNumber(value, numeric)),
    Match.when("boolean", () =>
      Match.value(value).pipe(
        Match.when(Match.is(null, "false", 0), () => false),
        Match.when(Match.is("true", 1), () => true),
        Match.orElse(() => value),
      ),
    ),
    Match.when("string", () =>
      Match.value(value).pipe(
        Match.when(Match.null, () => ""),
        Match.when(Predicate.isNumber, (number) => String(number)),
        Match.when(Predicate.isBoolean, (flag) => String(flag)),
        Match.orElse(() => value),
      ),
    ),
    Match.when("null", () => (value === "" || value === 0 || value === false ? null : value)),
    Match.orElse(() => value),
  );
const matchesType = (value: JsonValue, type: string) =>
  Match.value(type).pipe(
    Match.when("null", () => value === null),
    Match.when("array", () => isJsonArray(value)),
    Match.when("object", () => isJsonObject(value)),
    Match.when("integer", () => Predicate.isNumber(value) && Number.isInteger(value)),
    Match.when("number", () => Predicate.isNumber(value)),
    Match.when("string", () => Predicate.isString(value)),
    Match.when("boolean", () => Predicate.isBoolean(value)),
    Match.orElse(() => false),
  );

/**
 * Repairs common model mistakes against the schema. It walks unions, `$ref`, `if`/`then`/`else`,
 * tuples, and pattern and additional properties. A value that cannot be repaired stays as it is.
 */
/** The first of `types` that converts `value`, `null` last, unless one already fits it. */
const convertedType = (value: JsonValue, type: JsonSchemaNode["type"]): JsonValue => {
  const types: ReadonlyArray<string> = Predicate.isString(type) ? [type] : (type ?? []);
  const order = [
    ...types.filter((name) => name !== "null"),
    ...(types.includes("null") ? ["null"] : []),
  ];
  return types.some((name) => matchesType(value, name))
    ? value
    : Arr.findFirst(order, (name) =>
        Option.liftPredicate(convertPrimitive(value, name), (converted) => converted !== value),
      ).pipe(Option.getOrElse(() => value));
};

const isSchemaObject = (node: Node): node is JsonSchemaNode => Predicate.isObject(node);

/** A field and the value it has after a step. */
type Field = readonly [key: string, value: JsonValue];

/**
 * Repairs common model mistakes against the schema. It walks unions, `$ref`, `if`/`then`/`else`,
 * tuples, and pattern and additional properties. A value that cannot be repaired stays as it is.
 */
const coerceArguments = (value: JsonValue, { schema: root, draft, lookup }: Compiled) => {
  const check = (schema: Node, candidate: JsonValue) =>
    Predicate.isBoolean(schema) ? schema : validate(candidate, schema, draft, lookup).valid;
  const refTarget = (schema: JsonSchemaNode) =>
    Option.fromUndefinedOr(schema.__absolute_ref__).pipe(
      Option.flatMapNullishOr((uri) => lookup[uri]),
      Option.filter(isSchemaObject),
    );
  /** The `then` or `else` schema `candidate` takes, when `schema` has an `if`. */
  const branchOf = (schema: JsonSchemaNode, candidate: JsonValue) =>
    Option.flatMapNullishOr(Option.fromUndefinedOr(schema.if), (condition) =>
      check(condition, candidate) ? schema.then : schema.else,
    );
  /** A schema not walked yet on this path. */
  const unvisited = (schema: Node, seen: ReadonlySet<JsonSchemaNode>) =>
    Option.filter(Option.liftPredicate(schema, isSchemaObject), (node) => !seen.has(node));
  const coerceUnion = (
    candidate: JsonValue,
    schemas: ReadonlyArray<Node>,
    seen: ReadonlySet<JsonSchemaNode>,
    required: ReadonlySet<string>,
  ): JsonValue =>
    Option.liftPredicate(candidate, (sent) => schemas.some((schema) => check(schema, sent))).pipe(
      Option.orElse(() =>
        Arr.findFirst(schemas, (schema) =>
          Option.liftPredicate(coerce(candidate, schema, seen, required), (converted) =>
            check(schema, converted),
          ),
        ),
      ),
      Option.getOrElse(() => candidate),
    );
  const requiredKeys = (
    schema: Node,
    candidate: JsonValue,
    seen: ReadonlySet<JsonSchemaNode> = new Set(),
  ): ReadonlySet<string> =>
    Option.match(unvisited(schema, seen), {
      onNone: () => new Set<string>(),
      onSome: (node) => {
        const nextSeen = new Set([...seen, node]);
        const children: ReadonlyArray<Node> = [
          ...(node.allOf ?? []),
          ...Option.toArray(refTarget(node)),
          ...Option.toArray(branchOf(node, candidate)),
        ];
        return new Set([
          ...(Array.isArray(node.required) ? node.required : []),
          ...children.flatMap((child) => [...requiredKeys(child, candidate, nextSeen)]),
        ]);
      },
    });
  /** The object's fields repaired against `properties`, `patternProperties` and the rest. */
  const coerceFields = (
    object: JsonObject,
    schema: JsonSchemaNode,
    required: ReadonlySet<string>,
  ): JsonObject => {
    const properties = new Map(Object.entries(schema.properties ?? {}));
    // A null the property cannot take is left out when the property is optional.
    const declared = Object.entries(object).flatMap(([key, field]): Array<Field> =>
      Option.match(Option.fromUndefinedOr(properties.get(key)), {
        onNone: () => [[key, field]],
        onSome: (property) =>
          field === null && !required.has(key) && !check(property, null)
            ? []
            : [[key, coerce(field, property)]],
      }),
    );
    const patterns = Object.entries(schema.patternProperties ?? {}).map(
      ([pattern, property]) => [new RegExp(pattern, "u"), property] as const,
    );
    const patterned = patterns.reduce(
      (fields, [expression, property]) =>
        fields.map(([key, field]): Field =>
          expression.test(key) ? [key, coerce(field, property)] : [key, field],
        ),
      declared,
    );
    const known = new Set([
      ...properties.keys(),
      ...declared
        .map(([key]) => key)
        .filter((key) => patterns.some(([expression]) => expression.test(key))),
    ]);
    const fields = Option.match(
      Option.filter(Option.fromUndefinedOr(schema.additionalProperties), isSchemaObject),
      {
        onNone: () => patterned,
        onSome: (additional) =>
          patterned.map(([key, field]): Field =>
            known.has(key) ? [key, field] : [key, coerce(field, additional)],
          ),
      },
    );
    return Object.fromEntries(fields);
  };
  /** The array's items repaired against `prefixItems` or a tuple `items`, then the rest. */
  const coerceItems = (items: ReadonlyArray<JsonValue>, schema: JsonSchemaNode) => {
    const tuple = schema.prefixItems ?? (Array.isArray(schema.items) ? schema.items : undefined);
    const rest = Array.isArray(schema.items) ? undefined : schema.items;
    return items.map((item, index) =>
      Option.match(Option.fromUndefinedOr(tuple?.[index] ?? rest), {
        onNone: () => item,
        onSome: (itemSchema) => coerce(item, itemSchema),
      }),
    );
  };
  const coerceSchema = (
    candidate: JsonValue,
    schema: JsonSchemaNode,
    seen: ReadonlySet<JsonSchemaNode>,
    inheritedRequired: ReadonlySet<string>,
  ): JsonValue => {
    const nextSeen = new Set([...seen, schema]);
    const required = new Set([...requiredKeys(schema, candidate), ...inheritedRequired]);
    const nested = (next: JsonValue, inner: Node) => coerce(next, inner, nextSeen, required);
    const viaRef = Option.match(refTarget(schema), {
      onNone: () => candidate,
      onSome: (target) => nested(candidate, target),
    });
    const viaAll = (schema.allOf ?? []).reduce(nested, viaRef);
    const viaUnions = [schema.anyOf, schema.oneOf].reduce(
      (next, union) =>
        Option.match(Option.fromUndefinedOr(union), {
          onNone: () => next,
          onSome: (schemas) => coerceUnion(next, schemas, nextSeen, required),
        }),
      viaAll,
    );
    const typed = convertedType(viaUnions, schema.type);
    const withMembers = Match.value(typed).pipe(
      Match.when(isJsonObject, (object): JsonValue => coerceFields(object, schema, required)),
      Match.when(isJsonArray, (items): JsonValue => coerceItems(items, schema)),
      Match.orElse((leaf) => leaf),
    );
    return Option.match(branchOf(schema, withMembers), {
      onNone: () => withMembers,
      onSome: (branch) => nested(withMembers, branch),
    });
  };
  const coerce = (
    candidate: JsonValue,
    schema: Node,
    seen: ReadonlySet<JsonSchemaNode> = new Set(),
    inheritedRequired: ReadonlySet<string> = new Set(),
  ): JsonValue =>
    Option.match(unvisited(schema, seen), {
      onNone: () => candidate,
      onSome: (node) => coerceSchema(candidate, node, seen, inheritedRequired),
    });
  return coerce(value, root);
};

/** Errors that only say that a nested check failed. The nested error says why. */
const isWrapperKeyword = Schema.is(
  Schema.Literals([
    "properties",
    "patternProperties",
    "items",
    "prefixItems",
    "additionalItems",
    "unevaluatedItems",
    "$ref",
    "$recursiveRef",
    "allOf",
    "if",
  ]),
);

/** The first line of what kept the validator from reading a schema, without its internal URIs. */
const unreadable = (error: Error) =>
  error.message
    .split("\n", 1)
    .join("")
    .replaceAll(initialBaseURI.href, "")
    .replace(/ +Absolute URI "[^"]*"\.?/, "")
    .trim();

/**
 * What is wrong with `value` against the JSON Schema `schema`, as TanStack's `validateJsonSchema`
 * reported it: each failed check as `location: error`, or why the schema could not be read. Nothing
 * when the value fits.
 */
export const jsonSchemaIssues = ({
  schema,
  value,
}: {
  readonly schema: JsonSchema.JsonSchema;
  readonly value: JsonValue;
}): Option.Option<ReadonlyArray<string>> =>
  Result.try({
    try: () => {
      const root = compile(toJsonObject(schema));
      const result = validate(value, root.schema, root.draft, root.lookup, false);
      const leaves = result.errors.filter((error) => !isWrapperKeyword(error.keyword));
      return result.valid
        ? Option.none<ReadonlyArray<string>>()
        : Option.some(
            (leaves.length > 0 ? leaves : result.errors).map(
              (error) => `${error.instanceLocation}: ${error.error}`,
            ),
          );
    },
    // The validator throws Errors; anything else carries no message.
    catch: (error) => (Predicate.isError(error) ? error : new Error("")),
  }).pipe(Result.getOrElse((error) => Option.some([unreadable(error)])));

/**
 * The arguments repaired to fit `schema`, when they do not fit it as sent and the repair makes them
 * fit. A schema the validator cannot read repairs nothing.
 */
export const repairedInput = ({
  schema,
  params,
}: {
  readonly schema: JsonSchema.JsonSchema;
  readonly params: JsonValue;
}): Option.Option<JsonValue> =>
  Option.flatten(
    Option.liftThrowable(() => {
      const root = compile(toJsonObject(schema));
      const fits = (candidate: JsonValue) =>
        validate(candidate, root.schema, root.draft, root.lookup, false).valid;
      return Option.liftPredicate(params, (sent) => !fits(sent)).pipe(
        Option.map((sent) =>
          Option.getOrElse(Option.liftThrowable(coerceArguments)(sent, root), () => sent),
        ),
        Option.filter((converted) => !deepCompareStrict(converted, params) && fits(converted)),
      );
    })(),
  );

/**
 * How the loop prepares a call of `tool`: its arguments as sent, else as repaired. A call that
 * fits neither fails with what was wrong with the arguments as sent.
 */
export const prepareRepaired = (tool: RunTool) => {
  const schema = toolParameters(tool.tool);
  return (params: JsonValue) =>
    tool.prepare(params).pipe(
      Effect.catch((error) =>
        Option.match(repairedInput({ schema, params }), {
          onNone: () => Effect.fail(error),
          onSome: (repaired) => Effect.mapError(tool.prepare(repaired), () => error),
        }),
      ),
    );
};
