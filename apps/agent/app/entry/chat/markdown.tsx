import { cjk } from "@streamdown/cjk";
import { createCodePlugin } from "@streamdown/code";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";

// cjk: bold/italic next to Korean text (`**값**입니다`) renders; plain CommonMark leaves the stars.
const code = createCodePlugin({
  themes: ["github-light", "github-dark"],
});
const plugins = { code, cjk };
const linkSafety = { enabled: true };

/** Assistant text as Markdown, tolerant of the unfinished syntax a stream produces mid-answer. */
export function Markdown({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <Streamdown
      plugins={plugins}
      isAnimating={streaming}
      animated
      // Links open only after the user confirms the destination.
      linkSafety={linkSafety}
      className="min-w-0 wrap-break-word"
    >
      {text}
    </Streamdown>
  );
}
