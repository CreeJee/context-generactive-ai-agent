import { OPENAI_IMAGE_MODELS, createOpenaiImage } from "@tanstack/ai-openai";
import { imageGenerationTool } from "@tanstack/ai-openai/tools";
import {
  anthropicImageProviderContract,
  imageRouteContracts,
  productionImageRouteContracts,
} from "memory-agent";
import { describe, expect, it } from "vite-plus/test";

describe("image route contracts", () => {
  it("tracks the installed OpenAI Provider Tool and every direct image model", () => {
    const providerTool = imageGenerationTool({});
    const directAdapter = createOpenaiImage("gpt-image-2", "test-key");
    expect(providerTool).toMatchObject({
      name: "image_generation",
      metadata: { __kind: "openai.image_generation" },
    });
    expect(directAdapter).toMatchObject({ kind: "image", name: "openai", model: "gpt-image-2" });
    expect(imageRouteContracts).toHaveLength(1 + OPENAI_IMAGE_MODELS.length);
    expect(
      imageRouteContracts
        .filter((route) => route.executionMode === "direct_adapter")
        .map((route) =>
          route.executorModel.type === "explicit" ? route.executorModel.model : "managed",
        ),
    ).toEqual([...OPENAI_IMAGE_MODELS]);
  });

  it("does not invent the Provider Tool executor model", () => {
    const route = imageRouteContracts.find(
      (candidate) => candidate.id === "openai:provider_tool:image_generation",
    );
    expect(route?.executorModel).toEqual({ type: "provider_managed" });
    expect(route?.billingAttribution).toBe("provider_managed");
    expect(route?.cancellation).toBe("chat_run_abort_signal");
  });

  it("keeps direct adapter model and billing attribution explicit", () => {
    const route = imageRouteContracts.find(
      (candidate) => candidate.id === "openai:direct_adapter:gpt-image-2",
    );
    expect(route?.executorModel).toEqual({ type: "explicit", model: "gpt-image-2" });
    expect(route?.billingAttribution).toBe("executor_model");
    expect(route?.cancellation).toBe("request_abort_signal");
  });

  it("records installed direct adapter edit limits", () => {
    const byModel = Object.fromEntries(
      imageRouteContracts.flatMap((route) =>
        route.executorModel.type === "explicit" ? [[route.executorModel.model, route]] : [],
      ),
    );
    expect(byModel["gpt-image-2"]?.input.maximumSourceImages).toBe(16);
    expect(byModel["dall-e-2"]?.input.maximumSourceImages).toBe(1);
    expect(byModel["dall-e-3"]?.operations).toEqual(["generate"]);
    expect(byModel["dall-e-3"]?.input.images).toBe(false);
  });

  it("requires persistence and defers MIME to provider options or byte detection", () => {
    for (const route of imageRouteContracts) {
      expect(route.output.persistenceRequired).toBe(true);
      expect(route.output.mime).toBe("provider_option_or_detect_bytes");
      expect(route.usage.costKnownBeforeExecution).toBe(false);
    }
  });

  it("classifies Anthropic image input separately from unsupported generation", () => {
    expect(anthropicImageProviderContract).toMatchObject({
      provider: "anthropic",
      verification: "unsupported",
      productionEnabled: false,
      imageInputSupported: true,
      imageGenerationSupported: false,
    });
    expect(new Set<string>(imageRouteContracts.map((route) => route.provider))).toEqual(
      new Set(["openai"]),
    );
  });

  it("keeps every route out of production until account entitlement is verified", () => {
    expect(imageRouteContracts.every((route) => route.verification === "unverified")).toBe(true);
    expect(imageRouteContracts.every((route) => route.productionEnabled === false)).toBe(true);
    expect(productionImageRouteContracts()).toEqual([]);
  });

  it("requires both verification and an explicit production flag", () => {
    const candidate = imageRouteContracts[0]!;
    expect(
      productionImageRouteContracts([
        { ...candidate, verification: "verified", productionEnabled: false },
        { ...candidate, verification: "unverified", productionEnabled: true },
        { ...candidate, verification: "verified", productionEnabled: true },
      ]),
    ).toHaveLength(1);
  });
});
