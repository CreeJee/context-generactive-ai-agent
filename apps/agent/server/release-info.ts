import { getAsset, isSea } from "node:sea";
import { Schema } from "effect";
import { ReleaseChannel } from "./release-contract.ts";

export const releaseInfoAsset = "release/info.json";

export const ReleaseInfo = Schema.Struct({
  version: Schema.String,
  channel: ReleaseChannel,
  target: Schema.String,
});
export type ReleaseInfo = typeof ReleaseInfo.Type;

const development: ReleaseInfo = {
  version: "0.0.0-dev",
  channel: "prerelease",
  target: `${process.platform}-${process.arch}`,
};

/** Build identity embedded as a SEA asset; source bundles identify themselves as development. */
export function readReleaseInfo(): ReleaseInfo {
  if (!isSea()) return development;
  return Schema.decodeSync(Schema.fromJsonString(ReleaseInfo))(getAsset(releaseInfoAsset, "utf8"));
}
