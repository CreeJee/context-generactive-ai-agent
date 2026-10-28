import { Array as Arr, Effect, Option, Schema, Stream } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { compactLegacyOwnerRpcFingerprint } from "./owner-rpc-fingerprint.ts";

export class OwnerRpcFingerprintMigrationError extends Schema.TaggedError<OwnerRpcFingerprintMigrationError>()(
  "OwnerRpcFingerprintMigrationError",
  { cause: Schema.Defect() },
) {}

const Row = Schema.Struct({
  rowid: Schema.Finite,
  fingerprint: Schema.String,
  bytes: Schema.Finite,
  protected: Schema.Finite,
});

/** Explicit operator maintenance only. Each row commits independently and can resume.
 * Immutable recovery receipts retain their exact original linked fingerprints.
 * A verified original-record backup is an operator prerequisite, not a startup policy.
 */
export const migrateOwnerRpcFingerprintBatch = Effect.fn("ownerRpc.migrateFingerprintBatch")(
  function* (afterRowid: number, limit: number) {
    const sql = yield* SqlClient.SqlClient;
    const failed = (cause: unknown) => OwnerRpcFingerprintMigrationError.make({ cause });
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
      return yield* failed("Fingerprint migration requires standalone commits");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32)
      return yield* failed("Fingerprint migration batch must contain 1 to 32 rows");
    const next = SqlSchema.findOneOption({
      Request: Schema.Finite,
      Result: Row,
      execute: (cursor) => sql`
        SELECT o.rowid,o.fingerprint,octet_length(o.fingerprint) bytes,
          EXISTS(SELECT 1 FROM owner_read_recoveries r WHERE r.run_id=o.run_id
            AND o.operation_id IN (r.operation_id,r.operation_id-1)) AS protected
        FROM owner_rpc_operations o WHERE o.rowid>${cursor} ORDER BY o.rowid LIMIT 1`,
    });
    /** The compacted fingerprint's bytes, when the row's fingerprint changed. */
    const compacted = (row: typeof Row.Type) =>
      Effect.gen(function* () {
        const compact = yield* Effect.try({
          try: () => compactLegacyOwnerRpcFingerprint(row.fingerprint),
          catch: failed,
        });
        if (compact === row.fingerprint) return Option.none<number>();
        const updated = yield* sql`
          UPDATE owner_rpc_operations SET fingerprint=${compact}
          WHERE rowid=${row.rowid} AND fingerprint=${row.fingerprint} RETURNING rowid`.pipe(
          Effect.mapError(failed),
        );
        if (updated.length !== 1) return yield* failed("Fingerprint changed during maintenance");
        return Option.some(new TextEncoder().encode(compact).length);
      });
    const { rows, ...batch } = yield* Stream.paginate(afterRowid, (cursor) =>
      next(cursor).pipe(
        Effect.mapError(failed),
        Effect.map(
          Option.match({
            onNone: () => [Arr.empty<typeof Row.Type>(), Option.none<number>()] as const,
            onSome: (row) => [Arr.of(row), Option.some(row.rowid)] as const,
          }),
        ),
      ),
    ).pipe(
      Stream.take(limit),
      Stream.runFoldEffect(
        () => ({
          cursor: afterRowid,
          migrated: 0,
          retained: 0,
          beforeBytes: 0,
          afterBytes: 0,
          rows: 0,
        }),
        (tally, row) => {
          const read = { ...tally, cursor: row.rowid, rows: tally.rows + 1 };
          return row.protected !== 0
            ? Effect.succeed({ ...read, retained: read.retained + 1 })
            : Effect.map(
                compacted(row),
                Option.match({
                  onNone: () => read,
                  onSome: (bytes) => ({
                    ...read,
                    migrated: read.migrated + 1,
                    beforeBytes: read.beforeBytes + row.bytes,
                    afterBytes: read.afterBytes + bytes,
                  }),
                }),
              );
        },
      ),
    );
    // Fewer rows than the batch asked for means the lookup ran past the last one.
    return { ...batch, done: rows < limit };
  },
);
