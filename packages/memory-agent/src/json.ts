import { Schema } from "effect";

/** A value that can be represented losslessly as JSON. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const JsonValue: Schema.Schema<JsonValue> = Schema.suspend(() =>
  Schema.Union(
    Schema.String,
    Schema.Number,
    Schema.Boolean,
    Schema.Null,
    Schema.Array(JsonValue),
    Schema.Record({ key: Schema.String, value: JsonValue }),
  ),
);
