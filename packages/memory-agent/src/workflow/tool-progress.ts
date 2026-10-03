import { createHash } from "node:crypto";
import type { ToolPhaseCompleteInfo } from "@tanstack/ai";
import { Option, Schema } from "effect";
import { JsonValue } from "../json.ts";

const bookkeeping = new Set([
  "get_workflow",
  "update_workflow_progress",
  "update_goal",
  "update_plan",
  "record_workflow_blocker",
  "read_skill",
]);
const volatileKeys = new Set(["snapshot", "nextCursor", "nextOffset", "durationMs", "elapsedMs"]);
const isString = Schema.is(Schema.String);
const isArray = Schema.is(Schema.Array(JsonValue));
const isObject = Schema.is(Schema.Record(Schema.String, JsonValue));
const decodeResult = Schema.decodeUnknownOption(JsonValue);
const decodeText = Schema.decodeUnknownOption(Schema.fromJsonString(JsonValue));
const decodeInput = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      expectedSha256: Schema.optionalKey(Schema.String),
      oldText: Schema.optionalKey(Schema.String),
      newText: Schema.optionalKey(Schema.String),
    }),
  ),
);

/** Compare substantive results, not call ids, timing or refreshed pagination tokens. */
function stable(value: JsonValue): JsonValue {
  if (isArray(value)) return value.map(stable);
  if (isObject(value))
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !volatileKeys.has(key))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}

/** Parse the SDK's heterogeneous result at this boundary before measuring progress. */
export function toolProgressFingerprint(
  name: string,
  args: string,
  result: ToolPhaseCompleteInfo["results"][number]["result"],
): string | null {
  if (bookkeeping.has(name)) return null;
  const parsed = isString(result)
    ? Option.orElse(decodeText(result), () => decodeResult(result))
    : decodeResult(result);
  if (Option.isNone(parsed)) return null;
  const value = parsed.value;
  if (value === null || (isString(value) && !value.trim())) return null;
  if (isObject(value)) {
    if (
      "error" in value ||
      value.approved === false ||
      value.isError === true ||
      (value.exitCode !== undefined && value.exitCode !== 0) ||
      value.signal != null
    )
      return null;
    if (Object.keys(value).length === 0) return null;
    if (["write_file", "edit_file", "write_outside_file"].includes(name)) {
      const input = decodeInput(args);
      if (Option.isNone(input)) return null;
      if (input.value.expectedSha256 !== undefined && input.value.expectedSha256 === value.sha256)
        return null;
      if (
        name === "edit_file" &&
        input.value.oldText !== undefined &&
        input.value.oldText === input.value.newText
      )
        return null;
    }
  }
  const encoded = JSON.stringify(stable(value));
  if (encoded === "[]") return null;
  return createHash("sha256").update(`${name}\n${encoded}`).digest("hex");
}
