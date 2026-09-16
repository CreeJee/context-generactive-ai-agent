import { AlertCircleIcon, XIcon } from "lucide-react";
import { useState } from "react";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "~/components/ui/attachment";
import { Dialog, DialogContent, DialogTitle } from "~/components/ui/dialog";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "~/components/ui/hover-card";
import { Spinner } from "~/components/ui/spinner";
import type { DraftImage } from "./draft-images";

/** An image shown in a sent message: its `#N` position and where to load it from. */
export interface MessageImage {
  readonly number: number;
  readonly url: string;
}

/** Full-size view of one image. */
function ImageDialog({ image, onClose }: { image: MessageImage | null; onClose: () => void }) {
  return (
    <Dialog open={image !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[min(90vw,64rem)] sm:max-w-[min(90vw,64rem)]">
        <DialogTitle>이미지 #{image?.number}</DialogTitle>
        {image && (
          <img
            src={image.url}
            alt={`첨부 이미지 #${image.number}`}
            className="max-h-[75vh] w-full rounded object-contain"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * A picture of a drawing the model wrote, under its tool call. It is the snapshot taken when the
 * file was written, so it still shows what was drawn after the file changes. Clicking opens it full
 * size.
 */
export function DrawingPicture({ url, path }: { url: string; path: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block w-fit max-w-full overflow-hidden rounded-md border bg-white"
        title={`${path} 크게 보기`}
      >
        <img src={url} alt={`그린 그림: ${path}`} className="max-h-80 max-w-full object-contain" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[min(90vw,64rem)] sm:max-w-[min(90vw,64rem)]">
          <DialogTitle className="font-mono text-sm">{path}</DialogTitle>
          <img
            src={url}
            alt={`그린 그림: ${path}`}
            className="max-h-[75vh] w-full rounded bg-white object-contain"
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Text of a user message split into plain runs and `#N` references to its images. */
type TextRun =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "reference"; readonly token: string; readonly image: MessageImage };

function splitReferences(text: string, images: readonly MessageImage[]): TextRun[] {
  const byNumber = new Map(images.map((image) => [image.number, image]));
  const runs: TextRun[] = [];
  let last = 0;
  for (const match of text.matchAll(/#(\d+)/g)) {
    const image = byNumber.get(Number(match[1]));
    if (!image) continue;
    if (match.index > last) runs.push({ kind: "text", text: text.slice(last, match.index) });
    runs.push({ kind: "reference", token: match[0], image });
    last = match.index + match[0].length;
  }
  if (last < text.length) runs.push({ kind: "text", text: text.slice(last) });
  return runs;
}

/**
 * A sent user message: its text with `#N` chips that preview their image on hover, and the images
 * underneath. Clicking either opens the image full size.
 */
export function UserMessageBody({
  text,
  images,
}: {
  text: string;
  images: readonly MessageImage[];
}) {
  const [open, setOpen] = useState<MessageImage | null>(null);
  return (
    <div className="flex flex-col items-end gap-1.5">
      {text.length > 0 && (
        <p className="max-w-[85%] rounded-2xl bg-primary px-3.5 py-2 text-sm/relaxed whitespace-pre-wrap text-primary-foreground">
          {splitReferences(text, images).map((run, index) => {
            switch (run.kind) {
              case "text":
                return <span key={index}>{run.text}</span>;
              case "reference":
                return (
                  <HoverCard key={index}>
                    <HoverCardTrigger
                      render={
                        <button
                          type="button"
                          onClick={() => setOpen(run.image)}
                          className="mx-0.5 rounded bg-primary-foreground/20 px-1 font-medium underline-offset-2 hover:underline"
                        />
                      }
                    >
                      {run.token}
                    </HoverCardTrigger>
                    <HoverCardContent className="w-56 p-1.5">
                      <img
                        src={run.image.url}
                        alt={`첨부 이미지 #${run.image.number}`}
                        className="max-h-48 w-full rounded object-contain"
                      />
                    </HoverCardContent>
                  </HoverCard>
                );
            }
          })}
        </p>
      )}
      {images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {images.map((image) => (
            <button
              key={image.number}
              type="button"
              onClick={() => setOpen(image)}
              className="relative overflow-hidden rounded-lg ring-1 ring-foreground/10"
            >
              <img
                src={image.url}
                alt={`첨부 이미지 #${image.number}`}
                className="h-28 max-w-48 object-cover"
              />
              <span className="absolute top-1 left-1 rounded bg-black/60 px-1 text-[0.625rem] text-white">
                #{image.number}
              </span>
            </button>
          ))}
        </div>
      )}
      <ImageDialog image={open} onClose={() => setOpen(null)} />
    </div>
  );
}

/** What the attachment card shows for each draft state. */
function draftCard(image: DraftImage) {
  switch (image.status) {
    case "uploading":
      return { state: "uploading", description: "올리는 중…" } as const;
    case "ready":
      return { state: "done", description: "눌러서 본문에 넣기" } as const;
    case "failed":
      return { state: "error", description: image.reason } as const;
  }
}

/**
 * Images attached to the draft, above the input, as shadcn attachment cards. Clicking a card
 * inserts its `#N`; the × removes it. Failed uploads stay visible with the reason until removed.
 */
export function DraftImageTray({
  images,
  onReference,
  onRemove,
  className,
}: {
  images: readonly DraftImage[];
  onReference: (number: number) => void;
  onRemove: (key: string) => void;
  className?: string;
}) {
  if (images.length === 0) return null;
  return (
    <AttachmentGroup className={className}>
      {images.map((image) => {
        const card = draftCard(image);
        return (
          <Attachment key={image.key} orientation="vertical" state={card.state}>
            <AttachmentMedia variant="image">
              <img src={image.previewUrl} alt={image.name} />
              {image.status === "uploading" && <Spinner className="absolute" />}
              {image.status === "failed" && <AlertCircleIcon className="absolute" />}
            </AttachmentMedia>
            <AttachmentContent>
              <AttachmentTitle>#{image.number}</AttachmentTitle>
              <AttachmentDescription title={card.description}>
                {card.description}
              </AttachmentDescription>
            </AttachmentContent>
            {image.status === "ready" && (
              <AttachmentTrigger
                aria-label={`#${image.number} 본문에 넣기`}
                onClick={() => onReference(image.number)}
              />
            )}
            <AttachmentActions>
              <AttachmentAction
                variant="secondary"
                onClick={() => onRemove(image.key)}
                aria-label={`#${image.number} 첨부 제거`}
              >
                <XIcon />
              </AttachmentAction>
            </AttachmentActions>
          </Attachment>
        );
      })}
    </AttachmentGroup>
  );
}
