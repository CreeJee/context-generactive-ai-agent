import { Crypto, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { Atom } from "effect/reactivity";
import { ChatApiClient } from "memory-agent/chat-session";
import { appFetch } from "../shared/backend-restart";
import { browserCrypto } from "../shared/browser-crypto";

/**
 * The chat API's client for the whole page (docs/effect-ai-migration.md step 6), one registry for
 * its sessions and BTW threads. Requests go to the page's own origin through `appFetch`, which
 * names the build the page runs, as the page's other requests do.
 */
export const chatRuntime = Atom.runtime(
  Layer.mergeAll(
    ChatApiClient.layer.pipe(Layer.provide(FetchHttpClient.layer)),
    Layer.succeed(FetchHttpClient.Fetch, appFetch),
    Layer.succeed(Crypto.Crypto, browserCrypto),
  ),
);
