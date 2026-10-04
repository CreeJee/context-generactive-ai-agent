import type { ProviderId } from "../api";

export const providerLabels = {
  openai: "ChatGPT",
  anthropic: "Claude",
  "openai-compatible": "OpenAI 호환",
} satisfies Record<ProviderId, string>;
// SAFETY: providerLabels is the literal map above, and each key is a ProviderId.
export const providerIds = Object.keys(providerLabels) as ProviderId[];
export const providerOptions = providerIds.map((value) => ({
  value,
  label: providerLabels[value],
}));
export const isProviderId = (value: string): value is ProviderId =>
  providerIds.some((id) => id === value);
