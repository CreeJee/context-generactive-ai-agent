import type { StoredMessage } from "../chat-store/schema.ts";
import { optionalProperty } from "../optional-property.ts";
import { ImageExecutorModel } from "../providers/image-contracts.ts";
import type { ImageMediaAsset } from "../providers/image-media-contracts.ts";

/**
 * The messages a generated image is written as: the user's prompt, a `generate_image` call and its
 * result. Values only; the caller writes them down and turns the JSON values into text.
 */

export const imageToolName = "generate_image";

/** The arguments the recorded call carries. */
export const imageCallArguments = (prompt: string) => ({ prompt });

/** The result the recorded call returns. `preview` is read the way a tool result's pictures are. */
export const imageResult = (asset: ImageMediaAsset) => ({
  preview: { attachmentId: asset.attachment.id, mimeType: asset.attachment.mimeType },
  route: asset.executorMediaRouteId,
  model: ImageExecutorModel.$match(asset.executorMediaModel, {
    provider_managed: () => "provider_managed",
    explicit: ({ model }) => model,
  }),
  ...optionalProperty("estimatedCostUsd", asset.estimatedCostUsd),
});

export interface ImageMessageInput {
  readonly prompt: string;
  readonly asset: ImageMediaAsset;
  readonly ids: {
    readonly user: string;
    readonly assistant: string;
    readonly tool: string;
    readonly toolCall: string;
  };
  readonly createdAt: string;
  readonly argumentsText: string;
  readonly resultText: string;
}

/**
 * The three stored messages. The call is written as another model's (`source` is the media route,
 * not the chat model) so replay rewrites its id into the shape the current provider accepts.
 */
export const imageMessages = (input: ImageMessageInput): StoredMessage[] => [
  { role: "user", id: input.ids.user, createdAt: input.createdAt, content: input.prompt },
  {
    role: "assistant",
    id: input.ids.assistant,
    createdAt: input.createdAt,
    content: null,
    toolCalls: [
      {
        id: input.ids.toolCall,
        type: "function",
        function: { name: imageToolName, arguments: input.argumentsText },
      },
    ],
    source: { provider: input.asset.provider, model: input.asset.executorMediaRouteId },
    finishReason: "tool_calls",
  },
  {
    role: "tool",
    id: input.ids.tool,
    createdAt: input.createdAt,
    toolCallId: input.ids.toolCall,
    content: input.resultText,
  },
];
