import { OPENAI_IMAGE_MODELS, type OpenAIImageModel } from "@tanstack/ai-openai";

export type ImageExecutionMode = "provider_tool" | "direct_adapter";
export type ImageRouteVerification = "unverified" | "verified" | "unsupported";
export type ImageExecutorModel =
  | { readonly type: "provider_managed" }
  | { readonly type: "explicit"; readonly model: OpenAIImageModel };

export interface ImageRouteContract {
  readonly id: `openai:${ImageExecutionMode}:${string}`;
  readonly provider: "openai";
  readonly executionMode: ImageExecutionMode;
  readonly executorModel: ImageExecutorModel;
  readonly verification: ImageRouteVerification;
  readonly productionEnabled: boolean;
  readonly authentication: "openai_api_key";
  readonly billingAttribution: "provider_managed" | "executor_model";
  readonly operations: readonly ("generate" | "edit")[];
  readonly input: {
    readonly text: true;
    readonly images: boolean;
    readonly maximumSourceImages: number;
    readonly mask: boolean;
    readonly remoteUrlFetch: "not_applicable" | "disabled_by_default";
  };
  readonly output: {
    readonly sources: readonly ("url" | "base64")[];
    readonly mime: "provider_option_or_detect_bytes";
    readonly temporaryUrlPossible: boolean;
    readonly persistenceRequired: boolean;
  };
  readonly usage: {
    readonly tokenUsagePossible: boolean;
    readonly rawProviderUsagePreserved: boolean;
    readonly costKnownBeforeExecution: false;
  };
  readonly cancellation: "request_abort_signal" | "chat_run_abort_signal";
  readonly evidence: readonly string[];
}

export interface UnsupportedImageProviderContract {
  readonly provider: "anthropic";
  readonly verification: "unsupported";
  readonly productionEnabled: false;
  readonly imageInputSupported: true;
  readonly imageGenerationSupported: false;
  readonly evidence: readonly string[];
}

interface DirectImageModelCapability {
  readonly images: boolean;
  readonly maximumSourceImages: number;
  readonly mask: boolean;
}

const directModelCapabilities = {
  "gpt-image-2": { images: true, maximumSourceImages: 16, mask: true },
  "gpt-image-1": { images: true, maximumSourceImages: 16, mask: true },
  "gpt-image-1-mini": { images: true, maximumSourceImages: 16, mask: true },
  "dall-e-3": { images: false, maximumSourceImages: 0, mask: false },
  "dall-e-2": { images: true, maximumSourceImages: 1, mask: true },
} as const satisfies Record<OpenAIImageModel, DirectImageModelCapability>;

/**
 * Candidate contracts verified from installed package exports/types/source.
 * They remain disabled until the concrete account entitlement is smoke-tested.
 */
export const openAIImageRouteContracts: readonly ImageRouteContract[] = Object.freeze([
  {
    id: "openai:provider_tool:image_generation",
    provider: "openai",
    executionMode: "provider_tool",
    executorModel: { type: "provider_managed" },
    verification: "unverified",
    productionEnabled: false,
    authentication: "openai_api_key",
    billingAttribution: "provider_managed",
    operations: ["generate", "edit"],
    input: {
      text: true,
      images: true,
      maximumSourceImages: 1,
      mask: true,
      remoteUrlFetch: "not_applicable",
    },
    output: {
      sources: ["base64"],
      mime: "provider_option_or_detect_bytes",
      temporaryUrlPossible: false,
      persistenceRequired: true,
    },
    usage: {
      tokenUsagePossible: true,
      rawProviderUsagePreserved: true,
      costKnownBeforeExecution: false,
    },
    cancellation: "chat_run_abort_signal",
    evidence: [
      "@tanstack/ai-openai/tools imageGenerationTool export",
      "OpenAI Responses image_generation provider tool",
    ],
  },
  ...OPENAI_IMAGE_MODELS.map((model): ImageRouteContract => {
    const capability = directModelCapabilities[model];
    return {
      id: `openai:direct_adapter:${model}`,
      provider: "openai",
      executionMode: "direct_adapter",
      executorModel: { type: "explicit", model },
      verification: "unverified",
      productionEnabled: false,
      authentication: "openai_api_key",
      billingAttribution: "executor_model",
      operations: capability.images ? ["generate", "edit"] : ["generate"],
      input: {
        text: true,
        images: capability.images,
        maximumSourceImages: capability.maximumSourceImages,
        mask: capability.mask,
        remoteUrlFetch: capability.images ? "disabled_by_default" : "not_applicable",
      },
      output: {
        sources: ["url", "base64"],
        mime: "provider_option_or_detect_bytes",
        temporaryUrlPossible: true,
        persistenceRequired: true,
      },
      usage: {
        tokenUsagePossible: true,
        rawProviderUsagePreserved: false,
        costKnownBeforeExecution: false,
      },
      cancellation: "request_abort_signal",
      evidence: [
        "@tanstack/ai-openai OPENAI_IMAGE_MODELS",
        "OpenAIImageAdapter.generateImages installed implementation",
      ],
    };
  }),
]);

export const anthropicImageProviderContract: UnsupportedImageProviderContract = Object.freeze({
  provider: "anthropic",
  verification: "unsupported",
  productionEnabled: false,
  imageInputSupported: true,
  imageGenerationSupported: false,
  evidence: [
    "@tanstack/ai-anthropic exports no image adapter or image generation Provider Tool",
    "TanStack Anthropic adapter documentation: image generation is unsupported",
  ],
});

export const imageRouteContracts = openAIImageRouteContracts;

export function productionImageRouteContracts(
  contracts: readonly ImageRouteContract[] = imageRouteContracts,
): readonly ImageRouteContract[] {
  return contracts.filter(
    (contract) => contract.productionEnabled && contract.verification === "verified",
  );
}
