import { Effect, Option, Schema } from "effect";
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
    let cursor = afterRowid;
    let migrated = 0;
    let retained = 0;
    let beforeBytes = 0;
    let afterBytes = 0;
    for (let index = 0; index < limit; index++) {
      const found = yield* next(cursor).pipe(Effect.mapError(failed));
      if (Option.isNone(found))
        return { cursor, migrated, retained, beforeBytes, afterBytes, done: true };
      const row = found.value;
      cursor = row.rowid;
      if (row.protected !== 0) {
        retained++;
        continue;
      }
      const compact = yield* Effect.try({
        try: () => compactLegacyOwnerRpcFingerprint(row.fingerprint),
        catch: failed,
      });
      if (compact === row.fingerprint) continue;
      const updated = yield* sql`
        UPDATE owner_rpc_operations SET fingerprint=${compact}
        WHERE rowid=${row.rowid} AND fingerprint=${row.fingerprint} RETURNING rowid`.pipe(
        Effect.mapError(failed),
      );
      if (updated.length !== 1) return yield* failed("Fingerprint changed during maintenance");
      migrated++;
      beforeBytes += row.bytes;
      afterBytes += new TextEncoder().encode(compact).length;
    }
    return { cursor, migrated, retained, beforeBytes, afterBytes, done: false };
  },
);
