import { SecureRandom } from "effect/crypto";

/** Web Crypto's random bytes as the browser's Effect `SecureRandom` service. */
export const browserCrypto = SecureRandom.make((size) =>
  crypto.getRandomValues(new Uint8Array(size)),
);
