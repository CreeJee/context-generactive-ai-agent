import { Effect, Ref, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { EvidencePage } from "./nodes.ts";

const ResultPageReadReason = Schema.TaggedUnion({
  ReadFailed: { cause: Schema.Defect() },
  Changed: {},
});

export class ResultPageReadFailed extends Schema.TaggedError<ResultPageReadFailed>()(
  "ResultPageReadFailed",
  { reason: ResultPageReadReason },
) {}

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
    if (row === undefined) return null;
    const { bytes } = yield* Schema.decodeUnknownEffect(Block)(row).pipe(
      Effect.mapError((cause) =>
        ResultPageReadFailed.make({
          reason: ResultPageReadReason.cases.ReadFailed.make({ cause }),
        }),
      ),
    );
    let end = Math.min(blockBytes, bytes.length);
    // Include the rest of the last UTF-8 scalar. The next block always starts at a scalar boundary.
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end++;
    const text = yield* Effect.try({
      try: () =>
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, end)),
      catch: (cause) =>
        ResultPageReadFailed.make({
          reason: ResultPageReadReason.cases.ReadFailed.make({ cause }),
        }),
    });
    return { text, bytes: end };
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
    let index = indexes.find(([cached]) => cached === id)?.[1];
    if (index?.size !== size) {
      const points: Checkpoint[] = [];
      let byte = 0;
      let length = 0;
      while (byte < size) {
        points.push({ byte, offset: length });
        const part = yield* read(id, projectId, sessionId, byte, size);
        if (part === null) return null;
        length += part.text.length;
        byte += part.bytes;
        yield* Effect.yieldNow;
      }
      const built = { size, length, points };
      // Cached only when nothing changed meanwhile, checked and cached in one step.
      const unchanged = yield* Ref.modify(cache, (state) =>
        state.generation === started ? [true, withIndex(state, id, built)] : [false, state],
      );
      if (!unchanged) return yield* changed();
      index = built;
    }
    const start = Math.min(Math.max(0, Math.trunc(offset)), index.length);
    let point: Checkpoint = { byte: 0, offset: 0 };
    for (const candidate of index.points) {
      if (candidate.offset > start) break;
      point = candidate;
    }
    let text = "";
    let byte = point.byte;
    while (byte < size && text.length < start - point.offset + 4000) {
      const part = yield* read(id, projectId, sessionId, byte, size);
      if (part === null) return null;
      text += part.text;
      byte += part.bytes;
    }
    const begin = start - point.offset;
    let end = Math.min(begin + 4000, text.length);
    const last = text.charCodeAt(end - 1);
    if (start + end - begin < index.length && end - begin > 1 && last >= 0xd800 && last <= 0xdbff)
      end--;
    if ((yield* Ref.get(cache)).generation !== started) return yield* changed();
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
      const points: Checkpoint[] = text.length === 0 ? [] : [{ byte: 0, offset: 0 }];
      let byte = 0;
      let blockStart = 0;
      for (let offset = 0; offset < text.length;) {
        const scalar = text.codePointAt(offset)!;
        byte += scalar <= 0x7f ? 1 : scalar <= 0x7ff ? 2 : scalar <= 0xffff ? 3 : 4;
        offset += scalar > 0xffff ? 2 : 1;
        if (byte - blockStart >= blockBytes && offset < text.length) {
          points.push({ byte, offset });
          blockStart = byte;
        }
      }
      return Ref.update(cache, (state) =>
        withIndex(state, id, { size: byte, length: text.length, points }),
      );
    },
  };
});
