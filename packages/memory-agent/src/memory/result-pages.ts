import { Array as Arr, Effect, Option, Ref, Schema, Stream } from "effect";
import { SqlClient } from "effect/sql";
import type { EvidencePage } from "./nodes.ts";

const ResultPageReadReason = Schema.TaggedUnion({
  ReadFailed: { cause: Schema.Defect() },
  Changed: {},
});

export class ResultPageReadFailed extends Schema.TaggedError<
  ResultPageReadFailed,
  { readonly brand: unique symbol }
>()("ResultPageReadFailed", { reason: ResultPageReadReason }) {}

const Metadata = Schema.Struct({ size: Schema.Finite });
const Block = Schema.Struct({ bytes: Schema.Uint8Array });
const blockBytes = 64 * 1024;
interface Checkpoint {
  readonly byte: number;
  readonly offset: number;
}
interface TextIndex {
  readonly size: number;
  readonly length: number;
  readonly points: readonly Checkpoint[];
}
interface Cache {
  /** Moves on at every invalidation, so a read that spanned one fails as changed. */
  readonly generation: number;
  /** Oldest first. */
  readonly indexes: ReadonlyArray<readonly [string, TextIndex]>;
}

/**
 * Where the block starting at `byte` ends: `blockBytes` on, and then past the rest of the UTF-8
 * scalar there, so the next block always starts at a scalar boundary.
 */
const blockEnd = (bytes: Uint8Array, byte: number) => {
  const cut = Math.min(byte + blockBytes, bytes.length);
  const continuation = bytes.subarray(cut).findIndex((value) => (value & 0xc0) !== 0x80);
  return continuation === -1 ? bytes.length : cut + continuation;
};

/** The checkpoints of blocks of `byte`-long UTF-8 parts whose text is `length` UTF-16 units long. */
const checkpoints = (blocks: ReadonlyArray<{ readonly byte: number; readonly length: number }>) => {
  const offsets = Arr.scan(blocks, 0, (offset, block) => offset + block.length);
  return {
    length: Arr.lastNonEmpty(offsets),
    points: Arr.zipWith(blocks, offsets, ({ byte }, offset) => ({ byte, offset })),
  };
};

/**
 * Append-only node text. Cache IDs are strings; no schema migration or persisted copy is needed.
 * Only bounded BLOB slices cross into JavaScript.
 */
export const createResultPageReader = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const failed = (cause: unknown) =>
    ResultPageReadFailed.make({ reason: ResultPageReadReason.cases.ReadFailed.make({ cause }) });
  const metadata = (id: string, projectId: string, sessionId: string) =>
    sql`SELECT length(CAST(text AS BLOB)) AS size FROM nodes
      WHERE id = ${id} AND kind = 'tool_result' AND project_id = ${projectId}
        AND session_id = ${sessionId}`.pipe(Effect.mapError(failed));
  const block = (start: number, length: number, id: string, projectId: string, sessionId: string) =>
    sql`SELECT substr(CAST(text AS BLOB), ${start}, ${length}) AS bytes FROM nodes
      WHERE id = ${id} AND kind = 'tool_result' AND project_id = ${projectId}
        AND session_id = ${sessionId}`.pipe(Effect.mapError(failed));
  const cache = yield* Ref.make<Cache>({ generation: 0, indexes: [] });
  /** Caches the index; past 32 entries, the earliest cached go first. */
  const withIndex = (state: Cache, id: string, index: TextIndex): Cache => ({
    ...state,
    indexes: [...state.indexes.filter(([cached]) => cached !== id), [id, index] as const].slice(
      -32,
    ),
  });
  const changed = () =>
    ResultPageReadFailed.make({ reason: ResultPageReadReason.cases.Changed.make({}) });
  const read = Effect.fnUntraced(function* (
    id: string,
    projectId: string,
    sessionId: string,
    byte: number,
    size: number,
  ) {
    const [row] = yield* block(
      byte + 1,
      Math.min(blockBytes + 4, size - byte),
      id,
      projectId,
      sessionId,
    );
    if (row === undefined) return Option.none();
    const { bytes } = yield* Schema.decodeUnknownEffect(Block)(row).pipe(
      Effect.mapError((cause) =>
        ResultPageReadFailed.make({
          reason: ResultPageReadReason.cases.ReadFailed.make({ cause }),
        }),
      ),
    );
    const end = blockEnd(bytes, 0);
    const text = yield* Effect.try({
      try: () =>
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, end)),
      catch: (cause) =>
        ResultPageReadFailed.make({
          reason: ResultPageReadReason.cases.ReadFailed.make({ cause }),
        }),
    });
    return Option.some({ byte, text, bytes: end });
  });
  /**
   * The blocks from `from` to the end, in order. A block of a node that went away is None, and the
   * last one read.
   */
  const blocksFrom = (
    id: string,
    projectId: string,
    sessionId: string,
    from: number,
    size: number,
  ) =>
    from >= size
      ? Stream.empty
      : Stream.paginate(from, (byte) =>
          Effect.map(
            read(id, projectId, sessionId, byte, size),
            (part) =>
              [
                Arr.of(part),
                Option.flatMap(part, ({ bytes }) =>
                  Option.liftPredicate(byte + bytes, (next) => next < size),
                ),
              ] as const,
          ),
        );
  /** Reads the node's text through once to index it; null when the node went away. */
  const indexOf = Effect.fnUntraced(function* (
    id: string,
    projectId: string,
    sessionId: string,
    size: number,
    started: number,
  ) {
    const parts = Option.all(
      yield* blocksFrom(id, projectId, sessionId, 0, size).pipe(
        Stream.tap(() => Effect.yieldNow),
        Stream.runCollect,
      ),
    );
    if (Option.isNone(parts)) return null;
    const built: TextIndex = {
      size,
      ...checkpoints(parts.value.map(({ byte, text }) => ({ byte, length: text.length }))),
    };
    // Cached only when nothing changed meanwhile, checked and cached in one step.
    const unchanged = yield* Ref.modify(cache, (state) =>
      state.generation === started ? [true, withIndex(state, id, built)] : [false, state],
    );
    yield* Effect.when(Effect.fail(changed()), Effect.succeed(!unchanged));
    return built;
  });
  const readPage = Effect.fn("Nodes.readToolResultPage")(function* (
    id: string,
    projectId: string,
    sessionId: string,
    offset: number,
  ): Effect.fn.Return<EvidencePage | null, ResultPageReadFailed> {
    const { generation: started, indexes } = yield* Ref.get(cache);
    // Authorization happens before text retrieval, including for cached indexes and deleted nodes.
    const [row] = yield* metadata(id, projectId, sessionId);
    if (row === undefined) return null;
    const { size } = yield* Schema.decodeUnknownEffect(Metadata)(row).pipe(
      Effect.mapError((cause) =>
        ResultPageReadFailed.make({
          reason: ResultPageReadReason.cases.ReadFailed.make({ cause }),
        }),
      ),
    );
    const cached = indexes.find(([cachedId]) => cachedId === id)?.[1];
    const index =
      cached?.size === size ? cached : yield* indexOf(id, projectId, sessionId, size, started);
    if (index === null) return null;
    const start = Math.min(Math.max(0, Math.trunc(offset)), index.length);
    // Offsets only grow, so the last checkpoint at or before the start is the nearest.
    const point = Option.getOrElse(
      Arr.findLast(index.points, (candidate) => candidate.offset <= start),
      (): Checkpoint => ({ byte: 0, offset: 0 }),
    );
    const begin = start - point.offset;
    // Blocks are read until they hold the page.
    const pageText = Option.flatten(
      yield* blocksFrom(id, projectId, sessionId, point.byte, size).pipe(
        Stream.scan(
          () => Option.some(""),
          (text, part) => Option.zipWith(text, part, (text, { text: more }) => text + more),
        ),
        Stream.takeUntil((text) =>
          Option.match(text, { onNone: () => true, onSome: (text) => text.length >= begin + 4000 }),
        ),
        Stream.runLast,
      ),
    );
    if (Option.isNone(pageText)) return null;
    const text = pageText.value;
    const cut = Math.min(begin + 4000, text.length);
    const last = text.charCodeAt(cut - 1);
    // A page that would end between the halves of a pair stops before it, unless that leaves it empty.
    const end =
      start + cut - begin < index.length && cut - begin > 1 && last >= 0xd800 && last <= 0xdbff
        ? cut - 1
        : cut;
    yield* Effect.when(
      Effect.fail(changed()),
      Effect.map(Ref.get(cache), (state) => state.generation !== started),
    );
    return {
      id,
      kind: "tool_result",
      text: text.slice(begin, end),
      offset: start,
      nextOffset: start + end - begin < index.length ? start + end - begin : null,
      length: index.length,
    };
  });
  return {
    read: readPage,
    invalidate: Ref.update(cache, (state) => ({ generation: state.generation + 1, indexes: [] })),
    /** Saving already has the complete redacted string. Index it here, before any page is asked for. */
    remember: (id: string, text: string) => {
      // The text as stored, in the blocks a read of it would take.
      const bytes = new TextEncoder().encode(text);
      const decoder = new TextDecoder();
      const blocks = Arr.unfold(0, (byte) =>
        Option.map(
          Option.liftPredicate(byte, (from) => from < bytes.length),
          (from) => {
            const end = blockEnd(bytes, from);
            return [
              { byte: from, length: decoder.decode(bytes.subarray(from, end)).length },
              end,
            ] as const;
          },
        ),
      );
      return Ref.update(cache, (state) =>
        withIndex(state, id, { size: bytes.length, ...checkpoints(blocks) }),
      );
    },
  };
});
