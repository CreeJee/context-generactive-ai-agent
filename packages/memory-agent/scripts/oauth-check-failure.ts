import { Schema } from "effect";

/** Why a one-off OAuth protocol check failed, without provider response content. */
export const OAuthCheckReason = Schema.TaggedUnion({
  browser_open_failed: {},
  login_not_connected: {},
  refresh_not_connected: {},
  stream_text_missing: {},
  tool_call_missing: {},
});

const reasonName = OAuthCheckReason.match({
  browser_open_failed: () => "browser_open_failed",
  login_not_connected: () => "login_not_connected",
  refresh_not_connected: () => "refresh_not_connected",
  stream_text_missing: () => "stream_text_missing",
  tool_call_missing: () => "tool_call_missing",
});

/** Expected failures of the one-off OAuth protocol checks, without provider response content. */
export class OAuthCheckFailed extends Schema.TaggedError<OAuthCheckFailed>()("OAuthCheckFailed", {
  reason: OAuthCheckReason,
}) {
  override get message(): string {
    return reasonName(this.reason);
  }
}
