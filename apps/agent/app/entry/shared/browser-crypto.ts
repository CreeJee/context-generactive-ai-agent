import { Crypto, Effect, PlatformError } from "effect";

/** Web Crypto is the browser platform implementation of the Effect Crypto service. */
export const browserCrypto = Crypto.make({
  randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.tryPromise({
      try: () =>
        crypto.subtle
          .digest(algorithm, Uint8Array.from(data))
          .then((buffer) => new Uint8Array(buffer)),
      catch: (cause) =>
        PlatformError.systemError({ _tag: "Unknown", module: "Crypto", method: "digest", cause }),
    }),
});
