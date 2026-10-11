import { Context, Layer } from "effect";
import { runtimeArtifact } from "../runtime/resources.ts";

/** Build-time artifact manifest selected by the package/application bundle.
 * Production never accepts a source entry and never invokes Vite at startup or on first request.
 */
export class OwnerNativeBuild extends Context.Service<
  OwnerNativeBuild,
  { readonly manifest: string }
>()("memory-agent/agent/owner-native-build/OwnerNativeBuild") {
  static readonly production = {
    get manifest() {
      return runtimeArtifact("artifact-manifest.json");
    },
  };
  static readonly layer = Layer.succeed(OwnerNativeBuild, OwnerNativeBuild.production);
}
