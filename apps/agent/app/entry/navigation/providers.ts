import type { ModelSelection, ProviderId, ProviderModel } from "../api";

export const providerLabels = {
  openai: "ChatGPT",
  anthropic: "Claude",
  "openai-compatible": "OpenAI 호환",
} satisfies Record<ProviderId, string>;

/**
 * The reasoning efforts the selected model lets the user pick, as the sidebar and `/effort` offer
 * them. A compatible endpoint that published no effort list has only its server default, so none.
 */
export function effortChoices(selection: ModelSelection, model: ProviderModel) {
  const compatible = selection.provider === "openai-compatible";
  if (compatible && model.supportedReasoningEfforts.length <= 1) return [];
  return model.supportedReasoningEfforts.map((effort) => ({
    id: effort,
    label: compatible && effort === "default" ? "서버 기본값" : `추론 ${effort}`,
  }));
}
