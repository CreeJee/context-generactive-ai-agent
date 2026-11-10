import { msg } from "@lingui/core/runtime-macro";
import { i18n } from "../i18n.ts";

/** Titles use already-redacted stored message text, never a new model request. */
export function firstMessageTitle(text: string): string {
  const characters = Array.from(text.trim().replace(/\s+/g, " "));
  return (
    (characters.length > 60 ? characters.slice(0, 60).join("") + "…" : characters.join("")) ||
    i18n._(
      msg({
        message: "이미지 대화",
        comment: "Title of a conversation whose first message has no text, such as an image alone",
      }),
    )
  );
}
