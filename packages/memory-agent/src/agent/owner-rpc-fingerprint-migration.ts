import { Effect, Schema } from "effect";
import type { Database } from "../db/database.ts";
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
  function* (
    database: Pick<Database["Service"], "sqlite" | "atomic">,
    afterRowid: number,
    limit: number,
  ) {
    const { sqlite, atomic } = database;
    const { next, update } = yield* Effect.try({
      try: () => {
        if (sqlite.isTransaction)
          throw new Error("Fingerprint migration requires standalone commits");
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32)
          throw new Error("Fingerprint migration batch must contain 1 to 32 rows");
        const next = sqlite.prepare(`SELECT o.rowid,o.fingerprint,octet_length(o.fingerprint) bytes,
          EXISTS(SELECT 1 FROM owner_read_recoveries r WHERE r.run_id=o.run_id
            AND o.operation_id IN (r.operation_id,r.operation_id-1)) AS protected
          FROM owner_rpc_operations o WHERE o.rowid>? ORDER BY o.rowid LIMIT 1`);
        const update = sqlite.prepare(
          "UPDATE owner_rpc_operations SET fingerprint=? WHERE rowid=? AND fingerprint=?",
        );
        return { next, update };
      },
      catch: (cause) => OwnerRpcFingerprintMigrationError.make({ cause }),
    });
    let cursor = afterRowid;
    let migrated = 0;
    let retained = 0;
    let beforeBytes = 0;
    let afterBytes = 0;
    for (let index = 0; index < limit; index++) {
      const raw = yield* Effect.try({
        try: () => next.get(cursor),
        catch: (cause) => OwnerRpcFingerprintMigrationError.make({ cause }),
      });
      if (raw === undefined)
        return { cursor, migrated, retained, beforeBytes, afterBytes, done: true };
      const row = yield* Schema.decodeUnknownEffect(Row)(raw).pipe(
        Effect.mapError((cause) => OwnerRpcFingerprintMigrationError.make({ cause })),
      );
      cursor = row.rowid;
      if (row.protected !== 0) {
        retained++;
        continue;
      }
      const compact = yield* Effect.try({
        try: () => compactLegacyOwnerRpcFingerprint(row.fingerprint),
        catch: (cause) => OwnerRpcFingerprintMigrationError.make({ cause }),
      });
      if (compact === row.fingerprint) continue;
      yield* Effect.try({
        try: () =>
          atomic(() => {
            if (update.run(compact, row.rowid, row.fingerprint).changes !== 1)
              throw new Error("Fingerprint changed during maintenance");
          }),
        catch: (cause) => OwnerRpcFingerprintMigrationError.make({ cause }),
      });
      migrated++;
      beforeBytes += row.bytes;
      afterBytes += new TextEncoder().encode(compact).length;
    }
    return { cursor, migrated, retained, beforeBytes, afterBytes, done: false };
  },
);
