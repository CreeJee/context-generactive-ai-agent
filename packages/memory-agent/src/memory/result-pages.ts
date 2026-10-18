import { Effect, MutableHashMap, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { EvidencePage } from "./nodes.ts";

export class ResultPageReadFailed extends Schema.TaggedError<ResultPageReadFailed>()(
  "ResultPageReadFailed",
  {
    reason: Schema.Union([
      Schema.TaggedStruct("ReadFailed", { cause: Schema.Defect() }),
      Schema.TaggedStruct("Changed", {}),
    ]),
  },
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

/**
 * Append-only node text. Cache IDs are strings; no schema migration or persisted copy is needed.
 * Only bounded BLOB slices cross into JavaScript.
 */
export const createResultPageReader = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const failed = (cause: unknown) =>
    ResultPageReadFailed.make({ reason: { _tag: "ReadFailed", cause } });
  const metadata = (id: string, projectId: string, sessionId: string) =>
    sql`SELECT length(CAST(text AS BLOB)) AS size FROM nodes
      WHERE id = ${id} AND kind = 'tool_result' AND project_id = ${projectId}
        AND session_id = ${sessionId}`.pipe(Effect.mapError(failed));
  const block = (start: number, length: number, id: string, projectId: string, sessionId: string) =>
    sql`SELECT substr(CAST(text AS BLOB), ${start}, ${length}) AS bytes FROM nodes
      WHERE id = ${id} AND kind = 'tool_result' AND project_id = ${projectId}
        AND session_id = ${sessionId}`.pipe(Effect.mapError(failed));
  const cache = MutableHashMap.empty<string, TextIndex>();
  let generation = 0;
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
        ResultPageReadFailed.make({ reason: { _tag: "ReadFailed", cause } }),
      ),
    );
    let end = Math.min(blockBytes, bytes.length);
    // Include the rest of the last UTF-8 scalar. The next block always starts at a scalar boundary.
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end++;
    const text = yield* Effect.try({
      try: () =>
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, end)),
      catch: (cause) => ResultPageReadFailed.make({ reason: { _tag: "ReadFailed", cause } }),
    });
    return { text, bytes: end };
  });
  const readPage = Effect.fn("Nodes.readToolResultPage")(function* (
    id: string,
    projectId: string,
    sessionId: string,
    offset: number,
  ): Effect.fn.Return<EvidencePage | null, ResultPageReadFailed> {
    const started = generation;
    // Authorization happens before text retrieval, including for cached indexes and deleted nodes.
    const [row] = yield* metadata(id, projectId, sessionId);
    if (row === undefined) return null;
    const { size } = yield* Schema.decodeUnknownEffect(Metadata)(row).pipe(
      Effect.mapError((cause) =>
        ResultPageReadFailed.make({ reason: { _tag: "ReadFailed", cause } }),
      ),
    );
    let index = Option.getOrUndefined(MutableHashMap.get(cache, id));
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
      if (generation !== started)
        return yield* ResultPageReadFailed.make({ reason: { _tag: "Changed" } });
      index = { size, length, points };
      MutableHashMap.set(cache, id, index);
      for (const old of MutableHashMap.keys(cache)) {
        if (MutableHashMap.size(cache) <= 32) break;
        MutableHashMap.remove(cache, old);
      }
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
    if (generation !== started)
      return yield* ResultPageReadFailed.make({ reason: { _tag: "Changed" } });
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
    invalidate(this: void) {
      generation++;
      MutableHashMap.clear(cache);
    },
    /** Saving already has the complete redacted string. Index it here, before any page is asked for. */
    remember(id: string, text: string) {
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
      MutableHashMap.set(cache, id, { size: byte, length: text.length, points });
      for (const old of MutableHashMap.keys(cache)) {
        if (MutableHashMap.size(cache) <= 32) break;
        MutableHashMap.remove(cache, old);
      }
    },
  };
});
