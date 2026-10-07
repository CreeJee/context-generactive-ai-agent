import { Cause, Stream } from "effect";

/** SDKs requiring AsyncGenerator receive real next/return/throw methods, without a type cast. */
export function nativeStream<A, E>(stream: Stream.Stream<A, E>): AsyncGenerator<A, void, unknown> {
  const iterator = Stream.toAsyncIterable(stream)[Symbol.asyncIterator]();
  let closed = false;
  let pending = Promise.resolve();
  const done = (): IteratorReturnResult<void> => ({ done: true, value: undefined });
  const result = (item: IteratorResult<A>): IteratorResult<A, void> =>
    item.done ? done() : { done: false, value: item.value };
  const reject = <E>(error: E): Promise<never> =>
    Promise.reject(error instanceof Cause.UnknownError ? error.cause : error);
  const generator: AsyncGenerator<A, void, unknown> = {
    next() {
      const next = pending.then(() => (closed ? done() : iterator.next().then(result, reject)));
      pending = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    return() {
      closed = true;
      // Closing interrupts the active pull and releases its Stream scope before resolving.
      return iterator.return === undefined
        ? Promise.resolve(done())
        : iterator.return().then(result, reject);
    },
    throw(error) {
      closed = true;
      return iterator.throw === undefined
        ? reject(error)
        : iterator.throw(error).then(result, reject);
    },
    [Symbol.asyncIterator]() {
      return generator;
    },
    [Symbol.asyncDispose]() {
      return generator.return().then(() => undefined);
    },
  };
  return generator;
}
