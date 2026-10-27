import { Array as Arr, Effect, HashMap, Option, Schema } from "effect";
import type { StoredMessage } from "../chat-store/schema.ts";
import { asRunFailed, type RunHook } from "../loop/run.ts";
import type { Attachment, AttachmentsApi } from "./attachments.ts";
import { attachmentIdOf } from "./urls.ts";

type ImageAttachments = Pick<AttachmentsApi, "get" | "forModelEffect" | "dataUrlEffect">;

interface Part {
  readonly type: string;
}

const decodeUrlImage = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("image"),
    source: Schema.Struct({ type: Schema.Literal("url"), value: Schema.String }),
  }),
);

/** The attachment a part shows by its URL, if it is one. */
const attachmentOf = (part: Part) =>
  Option.flatMap(decodeUrlImage(part), ({ source }) =>
    Option.fromNullishOr(attachmentIdOf(source.value)),
  );

const attachmentsIn = (contents: ReadonlyArray<ReadonlyArray<Part>>) =>
  Arr.dedupe(Arr.flatMap(contents, (parts) => Arr.getSomes(parts.map(attachmentOf))));

/** What a part that shows an attachment by its URL becomes for the model. */
type InlinePart =
  | { readonly type: "text"; readonly content: string }
  | {
      readonly type: "image";
      readonly source: { readonly type: "data"; readonly value: string; readonly mimeType: string };
    };

const unavailable: InlinePart = { type: "text", content: "[Attached image is unavailable.]" };

const inlineImage = Effect.fn("modelImages.inlineImage")(function* (
  attachments: ImageAttachments,
  attachment: Attachment,
) {
  const image = yield* attachments.forModelEffect(attachment);
  const prefix = `data:${image.mimeType};base64,`;
  const dataUrl = yield* attachments.dataUrlEffect(image);
  return {
    type: "image" as const,
    source: {
      type: "data" as const,
      value: dataUrl.slice(prefix.length),
      mimeType: image.mimeType,
    },
  };
});

/**
 * Reads each of `ids` once, all at the same time, and gives what puts them inline: a part that
 * shows one of them by URL becomes its image data, or a note when it is gone.
 */
const inlinerFor = Effect.fnUntraced(function* (
  attachments: ImageAttachments,
  ids: ReadonlyArray<string>,
) {
  const parts = HashMap.fromIterable(
    yield* Effect.forEach(
      ids,
      (id) =>
        Effect.flatMap(attachments.get(id), (attachment) =>
          Option.match(Option.fromNullishOr(attachment), {
            onNone: () => Effect.succeed<InlinePart>(unavailable),
            onSome: (found) => inlineImage(attachments, found),
          }),
        ).pipe(Effect.map((part) => [id, part] as const)),
      { concurrency: "unbounded" },
    ),
  );
  return <P extends Part>(part: P) =>
    Option.getOrElse(
      Option.flatMap(attachmentOf(part), (id) => HashMap.get(parts, id)),
      () => part,
    );
});

const isText = Schema.is(Schema.String);

const storedParts = (message: StoredMessage): ReadonlyArray<Part> =>
  message.role === "assistant" || isText(message.content) ? [] : message.content;

/**
 * Stored transcripts use browser-safe relative attachment URLs. Providers cannot fetch those, so
 * only the model-bound copy gets the smaller stored image as provider-neutral inline data: each
 * model step's history gets the images inline.
 */
export const modelImagesHook = (attachments: ImageAttachments): RunHook => ({
  request: (_scope, request) =>
    inlinerFor(attachments, attachmentsIn(request.history.map(storedParts))).pipe(
      Effect.map((inline) => ({
        ...request,
        history: request.history.map((message) =>
          message.role === "assistant" || isText(message.content)
            ? message
            : { ...message, content: message.content.map(inline) },
        ),
      })),
      Effect.mapError(asRunFailed),
    ),
});
