/**
 * The single backend owner of one storage root: `<storage>/backend.lock`.
 *
 * The app's server and the writing CLI commands take the same lock over the same file, so two
 * writers never open one storage folder at once. The record, the file mode and the stale-lock
 * rules are the ones the app has always used (decided 2026-10-?? and kept here when the lock moved
 * out of `apps/agent/server/dev-safety.ts` on 2026-11-08): a lock whose owner is alive is never
 * taken over, a record with this process's pid but another start time belongs to an earlier run
 * whose pid was reused, and the release removes the file only while this instance still owns it.
 *
 * Read-only commands never take this lock: they open the storage read-only and leave the app's
 * owner alone.
 */
import { Effect, FileSystem, Match, Option, Schema } from "effect";
import { path as hostPath } from "./synchronous-path.ts";

const { join } = hostPath;

/** What the lock file holds. Both the app and the CLI write this shape. */
export const StorageLockRecord = Schema.Struct({
  pid: Schema.Finite,
  /** The owner's start time; tells this process apart from an earlier one given the same pid. */
  startedAt: Schema.optional(Schema.Finite),
  instanceId: Schema.String,
  port: Schema.Finite,
});
export type StorageLockRecord = typeof StorageLockRecord.Type;

const lockJson = Schema.fromJsonString(StorageLockRecord);
const decodeLock = Schema.decodeUnknownOption(lockJson);

/** The lock file of a storage root. */
export const storageLockFile = (storageRoot: string) => join(storageRoot, "backend.lock");

/** Another live backend owns this storage root; the caller must not preempt it. */
export class StorageLockHeld extends Schema.TaggedError<
  StorageLockHeld,
  { readonly brand: unique symbol }
>()("StorageLockHeld", {
  storageRoot: Schema.String,
  /** The owner's port, as it wrote it. A CLI owner writes 0: it serves nothing. */
  port: Schema.Finite,
  instanceId: Schema.String,
  pid: Schema.Finite,
}) {}

/** The lock file could not be written or read; the storage folder itself is the problem. */
export class StorageLockFailed extends Schema.TaggedError<
  StorageLockFailed,
  { readonly brand: unique symbol }
>()("StorageLockFailed", {
  storageRoot: Schema.String,
  cause: Schema.Defect(),
}) {}

// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const NativeError = Schema.Struct({ code: Schema.String });
    return Schema.is(NativeError)(error) && error.code === "EPERM";
  }
}

/**
 * Takes the storage root's lock for the calling Scope and releases it when the Scope closes.
 *
 * Fails with {@link StorageLockHeld} while another live backend owns the folder: the caller
 * reports it instead of taking the storage from a running app.
 */
export const lockStorageRoot = Effect.fnUntraced(function* (options: {
  readonly storageRoot: string;
  readonly port: number;
  readonly instanceId: string;
}) {
  const { storageRoot, port, instanceId } = options;
  const fs = yield* FileSystem.FileSystem;
  const file = storageLockFile(storageRoot);
  const failed = (cause: unknown) => StorageLockFailed.make({ storageRoot, cause });
  const record: StorageLockRecord = {
    pid: process.pid,
    startedAt: performance.timeOrigin,
    instanceId,
    port,
  };
  yield* fs
    .makeDirectory(storageRoot, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError(failed));
  const encoded = yield* Schema.encodeEffect(lockJson)(record).pipe(Effect.mapError(failed));
  const create = fs.writeFileString(file, encoded, { flag: "wx", mode: 0o600 });
  // A record with this process's pid but another start time was left by an earlier run whose pid
  // was reused, as a restarted container's entrypoint gets the same pid every time.
  const liveOwner = (held: StorageLockRecord) =>
    Match.value(held.pid === process.pid).pipe(
      Match.when(true, () => held.startedAt === performance.timeOrigin),
      Match.when(false, () => processIsAlive(held.pid)),
      Match.exhaustive,
    );
  const takeOverStale = fs.readFileString(file).pipe(
    Effect.map(decodeLock),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (held) =>
          Effect.fail(
            StorageLockHeld.make({
              storageRoot,
              port: held.port,
              instanceId: held.instanceId,
              pid: held.pid,
            }),
          ).pipe(Effect.when(Effect.succeed(liveOwner(held)))),
      }),
    ),
    Effect.andThen(fs.remove(file)),
    Effect.andThen(create),
  );
  yield* create.pipe(
    Effect.catchReason("PlatformError", "AlreadyExists", () => takeOverStale),
    Effect.mapError((error) => (Schema.is(StorageLockHeld)(error) ? error : failed(error))),
  );
  // The release removes the file only while this instance still owns it: a lock another owner
  // took over in the meantime is theirs to remove.
  yield* Effect.addFinalizer(() =>
    fs.readFileString(file).pipe(
      Effect.map(decodeLock),
      Effect.flatMap((held) =>
        fs
          .remove(file)
          .pipe(
            Effect.when(
              Effect.succeed(Option.exists(held, (owner) => owner.instanceId === instanceId)),
            ),
          ),
      ),
      Effect.ignore,
    ),
  );
});
