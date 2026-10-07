import { Schema } from "effect";

/** Expected failures of the one-off OAuth protocol checks, without provider response content. */
export class OAuthCheckFailed extends Schema.TaggedError<OAuthCheckFailed>()("OAuthCheckFailed", {
  reason: Schema.Union([
    Schema.TaggedStruct("browser_open_failed", {}),
    Schema.TaggedStruct("login_not_connected", {}),
    Schema.TaggedStruct("refresh_not_connected", {}),
    Schema.TaggedStruct("stream_text_missing", {}),
    Schema.TaggedStruct("tool_call_missing", {}),
  ]),
}) {
  override get message(): string {
    return this.reason._tag;
  }
}
