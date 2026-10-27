import { DatabaseSync } from "node:sqlite";
import { Context, Effect, Layer } from "effect";
import { defaultStorageRoot } from "../src/config/storage-root.ts";
import { Database } from "../src/db/database.ts";
import { OAuthProfiles } from "../src/oauth/accounts.ts";
import type { OAuthProvider } from "../src/oauth/protocol.ts";
import { path } from "../src/runtime/synchronous-path.ts";

const readOnlyProfiles = OAuthProfiles.layer.pipe(
  Layer.provide(
    Database.over(
      Effect.acquireRelease(
        Effect.flatMap(defaultStorageRoot, (root) =>
          Effect.try(() => new DatabaseSync(path.join(root, "agent.db"), { readOnly: true })),
        ),
        (sqlite) => Effect.sync(() => sqlite.close()),
      ),
    ),
  ),
);

/** The user's stored subscription profiles, read from the app database without writing to it. */
export const storedOAuthProfiles = Effect.fn("eval.storedOAuthProfiles")(function* (
  provider: OAuthProvider,
) {
  const services = yield* Layer.build(readOnlyProfiles);
  return yield* Context.get(services, OAuthProfiles).list(provider);
}, Effect.scoped);
