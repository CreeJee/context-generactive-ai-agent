import { dirname, join } from "node:path";
import { Context, Layer } from "effect";
import { runtimeRequire } from "../runtime/resources.ts";

/** Private dependency for owner-controlled builds, not a public artifact adoption API.
 * Production always uses the fixed package entry. Tests may supply controlled source through
 * Layer composition; HTTP, environment variables and executable descriptors cannot set this.
 * Registration must still build, hash, verify, persist and load the resulting artifact.
 */
export class OwnerNativeBuild extends Context.Service<
  OwnerNativeBuild,
  { readonly entry: string }
>()("memory-agent/agent/OwnerNativeBuild") {
  static readonly production = {
    get entry() {
      return join(
        dirname(runtimeRequire().resolve("memory-agent/package.json")),
        "src/agent/native-artifact-entry.ts",
      );
    },
  };
  static readonly layer = Layer.succeed(OwnerNativeBuild, OwnerNativeBuild.production);
}
