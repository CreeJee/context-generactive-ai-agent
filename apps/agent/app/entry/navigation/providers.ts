import type { ProviderId } from "../api";

export const providerLabels = {
  openai: "ChatGPT",
  anthropic: "Claude",
  "openai-compatible": "OpenAI 호환",
} satisfies Record<ProviderId, string>;
