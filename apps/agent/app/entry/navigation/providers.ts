import type { MessageDescriptor } from "@lingui/core";
import { msg, t } from "@lingui/core/macro";
import { Function as EffectFunction } from "effect";
import type { ModelSelection, ProviderId, ProviderModel } from "../api";

/** Each provider's display name, resolved where it is shown. */
export const providerLabels = {
  openai: msg({ message: "ChatGPT", comment: "Provider name: OpenAI's ChatGPT subscription" }),
  anthropic: msg({ message: "Claude", comment: "Provider name: Anthropic's Claude subscription" }),
  "openai-compatible": msg({
    message: "OpenAI 호환",
    comment: "Provider name: any server that speaks the OpenAI Chat Completions API",
  }),
} satisfies Record<ProviderId, MessageDescriptor>;

/**
 * The reasoning efforts the selected model lets the user pick, as the sidebar and `/effort` offer
 * them. A compatible endpoint that published no effort list has only its server default, so none.
 */
export const effortChoices: {
  (model: ProviderModel): (selection: ModelSelection) => ReadonlyArray<EffortChoice>;
  (selection: ModelSelection, model: ProviderModel): ReadonlyArray<EffortChoice>;
} = EffectFunction.dual(2, (selection: ModelSelection, model: ProviderModel) => {
  const compatible = selection.provider === "openai-compatible";
  if (compatible && model.supportedReasoningEfforts.length <= 1) return [];
  return model.supportedReasoningEfforts.map((effort) => ({
    id: effort,
    label:
      compatible && effort === "default"
        ? t({
            message: "서버 기본값",
            comment: "Reasoning effort option: whatever the endpoint server uses by default",
          })
        : t({
            message: `추론 ${effort}`,
            comment: "Reasoning effort option; effort is the level id, such as low or high",
          }),
  }));
});

export interface EffortChoice {
  readonly id: string;
  readonly label: string;
}
