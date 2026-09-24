import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";

// cjk: bold/italic next to Korean text (`**값**입니다`) renders; plain CommonMark leaves the stars.
const plugins = { code, cjk };

/** Assistant text as Markdown, tolerant of the unfinished syntax a stream produces mid-answer. */
export function Markdown({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <Streamdown
      plugins={plugins}
      isAnimating={streaming}
      animated
      // Links open only after the user confirms the destination.
      linkSafety={{ enabled: true }}
      className="min-w-0 break-words"
    >
      {text}
    </Streamdown>
  );
}
