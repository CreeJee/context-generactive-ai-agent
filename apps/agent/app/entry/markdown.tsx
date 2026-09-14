import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { ImageOffIcon } from "lucide-react";
import { Streamdown, type Components } from "streamdown";
import "streamdown/styles.css";

// cjk: bold/italic next to Korean text (`**값**입니다`) renders; plain CommonMark leaves the stars.
const plugins = { code, cjk };

const components: Components = {
  // Model answers can echo text from files and tool results. A remote image would be fetched
  // the moment it renders, so a prompt injection could leak data through its URL: never load it.
  img: ({ alt }) => (
    <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
      <ImageOffIcon className="size-3" />
      {alt || "이미지"} (외부 이미지는 불러오지 않아요)
    </span>
  ),
};

/** Assistant text as Markdown, tolerant of the unfinished syntax a stream produces mid-answer. */
export function Markdown({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <Streamdown
      plugins={plugins}
      components={components}
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
