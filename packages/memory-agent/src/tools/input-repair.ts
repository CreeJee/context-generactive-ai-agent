import {
  deepCompareStrict,
  dereference,
  initialBaseURI,
  validate,
  type Schema as JsonSchemaNode,
  type SchemaDraft,
} from "@cfworker/json-schema";
import {
  Effect,
  Function as EffectFunction,
  type JsonSchema,
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

/**
 * One schema made ready for the validator:
 * - `format` goes away. It is an annotation, as in 2019-09 and later.
 * - A boolean bound becomes the number form, so it works in every draft.
 * - OpenAPI 3.0 `nullable: true` lets the value be `null`: `null` joins `type` and `enum`. A schema
 *   with a keyword that can still reject `null` becomes `{ if: { type: 'null' }, else: schema }`,
 *   and its path goes in `wrapped`.
 */
const preparedSchema = (schema: JsonObject, path: string, wrapped: Array<string>): JsonObject => {
  const { format, ...withoutFormat } = schema;
  const bounded = booleanBounds.reduce<JsonObject>(
    (node, [bound, limit]) => {
      const flag = node[bound];
      if (!Predicate.isBoolean(flag)) return node;
      const { [bound]: _, [limit]: limitValue, ...rest } = node;
      if (flag && Predicate.isNumber(limitValue)) return { ...rest, [bound]: limitValue };
      return limitValue === undefined ? rest : { ...rest, [limit]: limitValue };
    },
    Predicate.isString(format) ? withoutFormat : schema,
  );
  if (bounded["nullable"] !== true) return bounded;
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
  if (!nullRejectingKeywords.some((key) => key in nullable)) return nullable;
  wrapped.push(path);
  const naming = EffectRecord.filter(nullable, (_, key) => isNamingKeyword(key));
  const inner = EffectRecord.filter(nullable, (_, key) => !isNamingKeyword(key));
  return { ...naming, if: { type: "null" }, else: inner };
};

/** `node` with each schema in it made ready for the validator, inner schemas first. */
const prepared = (node: JsonValue, path: string, wrapped: Array<string>): JsonValue => {
  if (isJsonArray(node))
    return node.map((item, index) => prepared(item, `${path}/${index}`, wrapped));
  if (!isJsonObject(node)) return node;
  const children = EffectRecord.map(node, (value, key) => {
    if (isDataKeyword(key)) return value;
    const keyPath = `${path}/${pointerToken(key)}`;
    return isSchemaMapKeyword(key) && isJsonObject(value)
      ? EffectRecord.map(value, (schema, name) =>
          prepared(schema, `${keyPath}/${pointerToken(name)}`, wrapped),
        )
      : prepared(value, keyPath, wrapped);
  });
  return preparedSchema(children, path, wrapped);
};

/** Any base works. A ref resolves as a URL, as cfworker reads it. */
const refBase = "https://ref.invalid/";
/** A `$ref` into a wrapped schema, moved to where that schema went. */
const movedRef = (ref: string, wrappedPath: string) => {
  if (!ref.startsWith("#")) return ref;
  const target = new URL(ref, refBase).href;
  const from = new URL(wrappedPath, refBase).href;
  return target.startsWith(`${from}/`)
    ? `${from}/else${target.slice(from.length)}`.slice(refBase.length)
    : ref;
};
const withMovedRefs = (node: JsonValue, wrapped: ReadonlyArray<string>): JsonValue => {
  if (isJsonArray(node)) return node.map((item) => withMovedRefs(item, wrapped));
  if (!isJsonObject(node)) return node;
  return EffectRecord.map(node, (value, key) =>
    isDataKeyword(key)
      ? value
      : key === "$ref" && Predicate.isString(value)
        ? wrapped.reduce(movedRef, value)
        : withMovedRefs(value, wrapped),
  );
};

/** The draft named by `$schema`, else 2020-12. */
const draftOf = (schema: JsonObject): SchemaDraft => {
  const uri = Predicate.isString(schema["$schema"]) ? schema["$schema"] : "";
  if (/draft-0[467]/.test(uri)) return "7";
  if (uri.includes("2019-09")) return "2019-09";
  return "2020-12";
};

interface Compiled {
  readonly schema: JsonSchemaNode;
  readonly draft: SchemaDraft;
  readonly lookup: Record<string, Node>;
}

const compile = (schema: JsonObject): Compiled => {
  const wrapped: Array<string> = [];
  const ready = prepared(schema, "#", wrapped);
  // cfworker marks resolved refs on the schema it is given, so it gets this copy.
  const copy: JsonSchemaNode = toJsonObject(
    wrapped.length > 0 ? withMovedRefs(ready, wrapped) : ready,
  );
  return { schema: copy, draft: draftOf(schema), lookup: dereference(copy) };
};

const decimal = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const convertPrimitive = (value: JsonValue, type: string): JsonValue => {
  switch (type) {
    case "number":
    case "integer": {
      if (value === null) return 0;
      if (Predicate.isBoolean(value)) return value ? 1 : 0;
      if (!Predicate.isString(value) || !decimal.test(value)) return value;
      const number = Number(value);
      return (type === "integer" ? Number.isSafeInteger(number) : Number.isFinite(number))
        ? number
        : value;
    }
    case "boolean":
      if (value === null || value === "false" || value === 0) return false;
      if (value === "true" || value === 1) return true;
      return value;
    case "string":
      if (value === null) return "";
      return Predicate.isNumber(value) || Predicate.isBoolean(value) ? String(value) : value;
    case "null":
      return value === "" || value === 0 || value === false ? null : value;
    default:
      return value;
  }
};
const matchesType = (value: JsonValue, type: string) => {
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return isJsonArray(value);
    case "object":
      return isJsonObject(value);
    case "integer":
      return Predicate.isNumber(value) && Number.isInteger(value);
    case "number":
      return Predicate.isNumber(value);
    case "string":
      return Predicate.isString(value);
    case "boolean":
      return Predicate.isBoolean(value);
    default:
      return false;
  }
};

/**
 * Repairs common model mistakes against the schema. It walks unions, `$ref`, `if`/`then`/`else`,
 * tuples, and pattern and additional properties. A value that cannot be repaired stays as it is.
 */
const coerceArguments = (value: JsonValue, { schema: root, draft, lookup }: Compiled) => {
  const check = (schema: Node, candidate: JsonValue) =>
    Predicate.isBoolean(schema) ? schema : validate(candidate, schema, draft, lookup).valid;
  const refTarget = (schema: JsonSchemaNode) => {
    const uri = schema.__absolute_ref__;
    const target = uri === undefined ? undefined : lookup[uri];
    return Predicate.isObject(target) ? target : undefined;
  };
  const coerceUnion = (
    candidate: JsonValue,
    schemas: ReadonlyArray<Node>,
    seen: ReadonlySet<JsonSchemaNode>,
    required: ReadonlySet<string>,
  ): JsonValue => {
    if (schemas.some((schema) => check(schema, candidate))) return candidate;
    for (const schema of schemas) {
      const converted = coerce(candidate, schema, seen, required);
      if (check(schema, converted)) return converted;
    }
    return candidate;
  };
  const requiredKeys = (
    schema: Node,
    candidate: JsonValue,
    seen: ReadonlySet<JsonSchemaNode> = new Set(),
  ): Set<string> => {
    if (Predicate.isBoolean(schema) || seen.has(schema)) return new Set();
    const nextSeen = new Set(seen).add(schema);
    const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
    const children: Array<Node> = [...(schema.allOf ?? [])];
    const target = refTarget(schema);
    if (target !== undefined) children.push(target);
    if (schema.if !== undefined) {
      const branch = check(schema.if, candidate) ? schema.then : schema.else;
      if (branch !== undefined) children.push(branch);
    }
    for (const child of children)
      for (const key of requiredKeys(child, candidate, nextSeen)) required.add(key);
    return required;
  };
  const coerce = (
    candidate: JsonValue,
    schema: Node,
    seen: ReadonlySet<JsonSchemaNode> = new Set(),
    inheritedRequired: ReadonlySet<string> = new Set(),
  ): JsonValue => {
    if (Predicate.isBoolean(schema) || seen.has(schema)) return candidate;
    const nextSeen = new Set(seen).add(schema);
    const required = requiredKeys(schema, candidate);
    for (const key of inheritedRequired) required.add(key);
    let next = candidate;
    const target = refTarget(schema);
    if (target !== undefined) next = coerce(next, target, nextSeen, required);
    for (const nested of schema.allOf ?? []) next = coerce(next, nested, nextSeen, required);
    if (schema.anyOf !== undefined) next = coerceUnion(next, schema.anyOf, nextSeen, required);
    if (schema.oneOf !== undefined) next = coerceUnion(next, schema.oneOf, nextSeen, required);
    const types = Predicate.isString(schema.type) ? [schema.type] : (schema.type ?? []);
    if (!types.some((type) => matchesType(next, type))) {
      const order: Array<string> = types.filter((type) => type !== "null");
      if (types.includes("null")) order.push("null");
      for (const type of order) {
        const converted = convertPrimitive(next, type);
        if (converted !== next) {
          next = converted;
          break;
        }
      }
    }
    if (isJsonObject(next)) {
      const object = new Map(Object.entries(next));
      const properties = Object.entries(schema.properties ?? {});
      const knownKeys = new Set(properties.map(([key]) => key));
      for (const [key, property] of properties) {
        const field = object.get(key);
        if (field === undefined) continue;
        if (field === null && !required.has(key) && !check(property, null)) object.delete(key);
        else object.set(key, coerce(field, property));
      }
      for (const [pattern, property] of Object.entries(schema.patternProperties ?? {})) {
        const expression = new RegExp(pattern, "u");
        for (const [key, field] of object) {
          if (!expression.test(key)) continue;
          knownKeys.add(key);
          object.set(key, coerce(field, property));
        }
      }
      const additional = schema.additionalProperties;
      if (Predicate.isObject(additional))
        for (const [key, entry] of object)
          if (!knownKeys.has(key)) object.set(key, coerce(entry, additional));
      next = Object.fromEntries(object);
    }
    if (isJsonArray(next)) {
      const tuple = schema.prefixItems ?? (Array.isArray(schema.items) ? schema.items : undefined);
      const rest = Array.isArray(schema.items) ? undefined : schema.items;
      next = next.map((item, index) => {
        const itemSchema = tuple?.[index] ?? rest;
        return itemSchema === undefined ? item : coerce(item, itemSchema);
      });
    }
    if (schema.if !== undefined) {
      const branch = check(schema.if, next) ? schema.then : schema.else;
      if (branch !== undefined) next = coerce(next, branch, nextSeen, required);
    }
    return next;
  };
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
      if (result.valid) return Option.none<ReadonlyArray<string>>();
      const leaves = result.errors.filter((error) => !isWrapperKeyword(error.keyword));
      return Option.some(
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
      if (fits(params)) return Option.none<JsonValue>();
      const converted = Option.getOrElse(
        Option.liftThrowable(coerceArguments)(params, root),
        () => params,
      );
      return !deepCompareStrict(converted, params) && fits(converted)
        ? Option.some(converted)
        : Option.none<JsonValue>();
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
