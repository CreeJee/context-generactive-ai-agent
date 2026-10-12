import { Effect, Schema } from "effect";
// Native host boundary: SEA assets are read through Node's synchronous API.
import { getAsset, isSea } from "node:sea";
import { BuildServerConfig, buildConfigAsset } from "../app/.server/build-config.ts";

/** The embedded settings could not be decoded. Carries no content: the asset holds a secret. */
export class BuildConfigInvalid extends Schema.TaggedError<BuildConfigInvalid>()(
  "BuildConfigInvalid",
  {},
) {}

/** Settings embedded by `scripts/package.ts`; source bundles have none. */
export const readBuildConfig: Effect.Effect<BuildServerConfig, BuildConfigInvalid> = Effect.suspend(
  () =>
    isSea()
      ? Schema.decodeEffect(Schema.fromJsonString(BuildServerConfig))(
          getAsset(buildConfigAsset, "utf8"),
        ).pipe(Effect.mapError(() => BuildConfigInvalid.make({})))
      : Effect.succeed<BuildServerConfig>({}),
);
