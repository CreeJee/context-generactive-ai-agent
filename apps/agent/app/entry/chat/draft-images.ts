import { useEffect, useRef, useState } from "react";
import { api, attachmentErrorMessage, type Attachment } from "../api";

/** Types the server accepts; anything else fails before uploading. */
const acceptedTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const acceptedImageTypes = [...acceptedTypes].join(",");

interface DraftImageBase {
  readonly key: string;
  /** `#N` in the draft. Stable while drafting, so references in the text never shift. */
  readonly number: number;
  /** Local object URL for the thumbnail. */
  readonly previewUrl: string;
  readonly name: string;
}

/** An image attached to the message being written. */
export type DraftImage =
  | (DraftImageBase & { readonly status: "uploading" })
  | (DraftImageBase & { readonly status: "ready"; readonly attachment: Attachment })
  | (DraftImageBase & { readonly status: "failed"; readonly reason: string });

/**
 * Images for the message being written: upload on attach, `#N` numbers that stay put until the
 * draft is sent or cleared, and object URLs released when an image leaves the draft.
 */
export function useDraftImages() {
  const [images, setImages] = useState<DraftImage[]>([]);
  const nextNumber = useRef(1);
  const live = useRef(images);
  live.current = images;

  useEffect(
    () => () => {
      for (const image of live.current) URL.revokeObjectURL(image.previewUrl);
    },
    [],
  );

  const settle = (key: string, settled: (base: DraftImageBase) => DraftImage) =>
    setImages((current) =>
      current.map((image) =>
        image.key === key
          ? settled({
              key: image.key,
              number: image.number,
              previewUrl: image.previewUrl,
              name: image.name,
            })
          : image,
      ),
    );

  const add = (files: readonly File[]) => {
    for (const file of files) {
      const base: DraftImageBase = {
        key: crypto.randomUUID(),
        number: nextNumber.current++,
        previewUrl: URL.createObjectURL(file),
        name: file.name,
      };
      if (!acceptedTypes.has(file.type)) {
        setImages((current) => [
          ...current,
          { ...base, status: "failed", reason: "PNG, JPEG, GIF, WebP 이미지만 올릴 수 있어요." },
        ]);
        continue;
      }
      setImages((current) => [...current, { ...base, status: "uploading" }]);
      api.uploadAttachment(file).then(
        (attachment) => settle(base.key, (image) => ({ ...image, status: "ready", attachment })),
        (error: Error) =>
          settle(base.key, (image) => ({
            ...image,
            status: "failed",
            reason: attachmentErrorMessage(error),
          })),
      );
    }
  };

  const remove = (key: string) =>
    setImages((current) =>
      current.filter((image) => {
        if (image.key !== key) return true;
        URL.revokeObjectURL(image.previewUrl);
        return false;
      }),
    );

  const clear = () => {
    for (const image of live.current) URL.revokeObjectURL(image.previewUrl);
    setImages([]);
    nextNumber.current = 1;
  };

  return { images, add, remove, clear };
}

/**
 * The text as sent: draft numbers become positions among the images actually sent, so `#3`
 * written after removing `#2` still points at the right image.
 */
export function renumberReferences(text: string, sentNumbers: readonly number[]) {
  const positions = new Map(sentNumbers.map((number, index) => [number, index + 1]));
  return text.replace(/#(\d+)/g, (token, digits: string) => {
    const position = positions.get(Number(digits));
    return position === undefined ? token : `#${position}`;
  });
}
