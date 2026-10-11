import { Context, Effect, Layer, Sink, Stream } from "effect";

/** The ACP SDK owns Web stream readers/writers; writes await the Effect sink's backpressure. */
const makeSdkStreams = Effect.fn("Acp.makeSdkStreams")(function* <E, R>(options: {
  readonly input: Stream.Stream<Uint8Array, E, R>;
  readonly output: Sink.Sink<void, Uint8Array, never, E, R>;
  readonly closeOutput: Effect.Effect<void, E, R>;
}) {
  const context = yield* Effect.context<R>();
  const run = Effect.runPromiseWith(context);
  const readable = yield* Stream.toReadableStreamEffect(options.input);
  const writable = new WritableStream<Uint8Array>({
    write: (chunk) => run(Stream.run(Stream.make(chunk), options.output)),
    close: () => run(options.closeOutput),
    abort: () => run(options.closeOutput),
  });
  return { readable, writable };
});

export class SdkStreams extends Context.Service<
  SdkStreams,
  { readonly readable: ReadableStream<Uint8Array>; readonly writable: WritableStream<Uint8Array> }
>()("memory-agent/acp/web-streams/SdkStreams") {
  static layer<E, R>(options: {
    readonly input: Stream.Stream<Uint8Array, E, R>;
    readonly output: Sink.Sink<void, Uint8Array, never, E, R>;
    readonly closeOutput: Effect.Effect<void, E, R>;
  }) {
    return Layer.effect(SdkStreams, makeSdkStreams(options));
  }
}
