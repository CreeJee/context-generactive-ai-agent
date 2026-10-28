import { NodeSocketServer } from "@effect/platform-node";
import { Effect, Schema } from "effect";

export class DevelopmentPortUnavailable extends Schema.TaggedError<
  DevelopmentPortUnavailable,
  { readonly brand: unique symbol }
>()("DevelopmentPortUnavailable", {
  label: Schema.String,
  host: Schema.String,
  port: Schema.Int,
  cause: Schema.Defect(),
}) {
  override get message() {
    return `${this.label} port ${this.port} (${this.host}) is unavailable: ${String(this.cause)}. Stop the existing dev server or choose another port.`;
  }
}

/** Binds and releases `host:port`, failing when another listener already holds it. */
export const assertPortAvailable = Effect.fn("dev.assertPortAvailable")(function* (
  port: number,
  host: string,
  label: string,
) {
  yield* Effect.scoped(NodeSocketServer.make({ port, host })).pipe(
    Effect.catchTag("SocketServerError", (error) =>
      Effect.fail(
        DevelopmentPortUnavailable.make({ label, host, port, cause: error.reason.cause }),
      ),
    ),
  );
});
