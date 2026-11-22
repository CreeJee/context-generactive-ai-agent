import { browserCrypto } from "../shared/browser-crypto";
import { Effect } from "effect";
import { isTruthy } from "../../truthy.ts";

const holderKey = "context-agent:page-holder";

const newHolder = () => {
  // Browser boundary: session ownership requires a cryptographic token.
  const created = Effect.runSync(browserCrypto.uuidV4());
  try {
    sessionStorage.setItem(holderKey, created);
  } catch {}
  return created;
};

/**
 * This page's name, sent with its requests. Kept in sessionStorage, so a reload is still the same
 * page.
 */
export function pageHolder() {
  try {
    const existing = sessionStorage.getItem(holderKey);
    if (isTruthy(existing)) return existing;
  } catch {}
  return newHolder();
}
