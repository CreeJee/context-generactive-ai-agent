import { ConfigProvider, Schema } from "effect";

/** SEA asset holding the server settings fixed when the executable was built. */
export const buildConfigAsset = "release/server-config.json";

/**
 * Server settings embedded at build time. The packaged app reads no env files, so the release job
 * passes the developer's report webhook here. Anyone holding the executable can extract it.
 */
export const BuildServerConfig = Schema.Struct({
  DISCORD_WEBHOOK_URL: Schema.optional(Schema.String),
});
export type BuildServerConfig = typeof BuildServerConfig.Type;

/** Adds the build-time settings behind the current provider: the runtime environment still wins. */
export const buildConfigLayer = (
  config: BuildServerConfig & { readonly CONTEXT_AGENT_RELEASE?: string },
) => ConfigProvider.layerAdd(ConfigProvider.fromUnknown(config));
