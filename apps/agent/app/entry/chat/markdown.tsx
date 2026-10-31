import { cjk } from "@streamdown/cjk";
import { createCodePlugin } from "@streamdown/code";
import { Schema } from "effect";
import { ImageIcon } from "lucide-react";
import { useState, type ComponentProps } from "react";
import { Streamdown, type Components } from "streamdown";
import "streamdown/styles.css";
import { Button } from "~/components/ui/button";
import { isTruthy } from "../../truthy.ts";

// cjk: bold/italic next to Korean text (`**값**입니다`) renders; plain CommonMark leaves the stars.
const code = createCodePlugin({
  themes: ["github-light", "github-dark"],
});
const plugins = { code, cjk };
const linkSafety = { enabled: true };

/** Markdown images carry a URL string; React also allows a Blob, which never leaves the page. */
const isSource = Schema.is(Schema.String);

/** The host an image would be fetched from, when that is another site; null for this app's own. */
const remoteHost = (src: string) => {
  const url = URL.parse(src, window.location.href);
  if (url === null) return null;
  switch (url.protocol) {
    case "http:":
    case "https:":
      return url.origin === window.location.origin ? null : url.host;
    default:
      return null;
  }
};

/**
 * An image in an answer. One from another site loads only when the user asks: fetching it on
 * render would send whatever the model put in its URL, including text from tool output.
 */
function AnswerImage({
  src,
  alt,
  node: _node,
  ...props
}: ComponentProps<"img"> & { node?: unknown }) {
  const [shown, setShown] = useState(false);
  const host = isSource(src) ? remoteHost(src) : null;
  if (host === null || shown) return <img src={src} alt={alt} {...props} />;
  return (
    <Button variant="outline" size="sm" onClick={() => setShown(true)}>
      <ImageIcon />
      {isTruthy(alt) ? `${alt} · ` : ""}
      {host}의 이미지 불러오기
    </Button>
  );
}

const components: Components = { img: AnswerImage };

/** Assistant text as Markdown, tolerant of the unfinished syntax a stream produces mid-answer. */
export function Markdown({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <Streamdown
      plugins={plugins}
      components={components}
      isAnimating={streaming}
      animated
      // Links open only after the user confirms the destination.
      linkSafety={linkSafety}
      // Streamdown sizes inline code and headings for a text-sm body.
      className="min-w-0 text-sm/relaxed wrap-break-word"
    >
      {text}
    </Streamdown>
  );
}
