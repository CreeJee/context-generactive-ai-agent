import type { OAuthProvider } from "./protocol.ts";

/** Copy for subscription accounts. Checked by lint/wording. */
export const oauthCopy = {
  /** Labels of accounts imported from the earlier single-account login, keyed by provider. */
  legacyLabel: {
    openai: "ChatGPT (이전 계정)",
    anthropic: "Claude (이전 계정)",
  } satisfies Record<OAuthProvider, string>,
};
