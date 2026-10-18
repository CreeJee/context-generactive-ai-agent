import { Effect, FileSystem, Layer, Option, Path, Predicate, Schema, ScopedRef } from "effect";
import { RpcServer } from "effect/rpc";
// Synchronous native/filesystem calls are confined to this owning worker.
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeWorkerRunner from "@effect/platform-node/NodeWorkerRunner";
import { threadId, workerData } from "node:worker_threads";
import { runNativeEffect } from "../../runtime/native-effect.ts";
import { requireRuntime } from "../../runtime/resources.ts";
import { initializeNodeSqlite } from "../../runtime/node-sqlite-bridge.ts";
import { DatabaseSync } from "node:sqlite";
import { assertDatabaseSchema } from "../../db/database.ts";
import {
  NativeOwnerFailed,
  NativeOwnerRpcs,
  type OwnerCommand,
  type OwnerReply,
  OwnerSetup,
} from "./worker-protocol.ts";

const fail = (reason: NativeOwnerFailed["reason"]) => NativeOwnerFailed.make({ reason });
/** Synchronous addon call. Its exception stays as the cause; only the reason crosses IPC. */
const native = <A>(operation: () => A, reason: NativeOwnerFailed["reason"] = "index-failed") =>
  Effect.try({ try: operation, catch: (cause) => NativeOwnerFailed.make({ reason, cause }) });
const canonicalId = Schema.String.check(
  Schema.makeFilter(
    (id) => id.length <= 20 && /^(0|[1-9][0-9]*)$/.test(id) && BigInt(id) <= 18446744073709551615n,
  ),
);
const decodeIds = Schema.decodeUnknownEffect(Schema.Array(canonicalId));

/** The owner's scoped resources and its command executor; Scope closure releases them. */
const owner = Effect.gen(function* () {
  const services = yield* Layer.build(Layer.merge(NodeFileSystem.layer, NodePath.layer));
  const paths = yield* Effect.provideContext(Path.Path, services);
  const fs = yield* Effect.provideContext(FileSystem.FileSystem, services);
  const files = <A>(operation: Effect.Effect<A, import("effect/PlatformError").PlatformError>) =>
    operation.pipe(
      Effect.mapError((cause) => NativeOwnerFailed.make({ reason: "index-failed", cause })),
    );
  const setup = yield* Schema.decodeUnknownEffect(OwnerSetup)(workerData).pipe(
    Effect.mapError(() => fail("invalid-input")),
  );
  if (
    setup.dimensions <= 0 ||
    setup.dimensions % 8 !== 0 ||
    setup.dimensions > 4294967295 ||
    ![1, 2, 4, 8].includes(setup.bits)
  )
    return yield* fail("invalid-input");
  if (setup.databasePath !== undefined)
    yield* native(() => {
      const sqlite = new DatabaseSync(setup.databasePath!, { readOnly: true });
      try {
        assertDatabaseSchema(sqlite);
      } finally {
        sqlite.close();
      }
    }, "native-incompatible");
  yield* files(fs.makeDirectory(setup.cacheDirectory, { recursive: true, mode: 0o700 }));
  const binding = yield* native(() => {
    const addon = requireRuntime("turbovec");
    const binding = addon.loadTurbovec();
    initializeNodeSqlite(addon.addonPath);
    return binding;
  }, "native-incompatible");
  if (
    !Predicate.isFunction(binding.MemoryReadSession) ||
    !Predicate.isFunction(binding.SearchControl)
  )
    return yield* fail("native-incompatible");
  yield* Effect.acquireRelease(
    native(
      () => new binding.CacheLease(paths.join(setup.cacheDirectory, "writer.lock")),
      "lease-unavailable",
    ),
    (lease) => Effect.sync(() => lease.close()),
  );
  const file = paths.join(setup.cacheDirectory, "index.tvim");
  const exists = yield* files(fs.exists(file));
  // The index is released when replaced or when the worker's Scope closes, not at GC.
  const owned = (create: () => InstanceType<typeof binding.VectorIndex>) =>
    Effect.acquireRelease(native(create), (index) => Effect.sync(() => index.close()));
  const empty = owned(() => new binding.VectorIndex(setup.dimensions, setup.bits));
  const indexRef = yield* ScopedRef.fromAcquire(
    exists ? owned(() => binding.VectorIndex.load(file)) : empty,
  );
  // Metadata belongs to the snapshot; never silently reuse a different vector layout.
  const compatible =
    exists &&
    (yield* native(() => {
      const saved = ScopedRef.getUnsafe(indexRef);
      return saved.dimensions() === setup.dimensions && saved.bits() === setup.bits;
    }));
  // Rebuild must be an explicit host recovery/publication, never a clean empty owner.
  if (exists && !compatible && setup.recover !== true) return yield* fail("index-failed");
  const needsReset = !compatible;
  if (exists && !compatible) yield* ScopedRef.set(indexRef, empty);
  // The worker owns this read-only connection; Scope closure closes it before the index.
  const reader =
    setup.databasePath === undefined
      ? Option.none<InstanceType<typeof binding.MemoryReadSession>>()
      : Option.some(
          yield* Effect.acquireRelease(
            native(() => new binding.MemoryReadSession(setup.databasePath!), "read-failed"),
            (session) => Effect.sync(() => session.close()),
          ),
        );
  const size = yield* native(() => ScopedRef.getUnsafe(indexRef).size());

  const execute = Effect.fnUntraced(function* (command: OwnerCommand) {
    if (command.epoch !== setup.epoch) return yield* fail("epoch-mismatch");
    // The single owner loop is the only reader and writer of indexRef, so `index` stays current
    // for this command; only reset replaces it, and ack then reads the replacement.
    const index = yield* ScopedRef.get(indexRef);
    const ack = (): OwnerReply => ({
      kind: "ack",
      requestId: command.requestId,
      epoch: setup.epoch,
      size: ScopedRef.getUnsafe(indexRef).size(),
    });
    const ids = (values: readonly string[]) =>
      decodeIds(values).pipe(Effect.mapError(() => fail("invalid-input")));
    switch (command.kind) {
      case "add":
        yield* ids(command.ids);
        if (
          command.vectors.length !== command.ids.length * setup.dimensions ||
          !command.vectors.every(Number.isFinite)
        )
          return yield* fail("invalid-input");
        yield* native(() => index.add(command.vectors, [...command.ids]));
        return yield* native(ack);
      case "remove": {
        yield* ids(command.ids);
        const removed = yield* native(() =>
          command.ids.reduce((count, id) => (index.remove(id) ? count + 1 : count), 0),
        );
        return yield* native((): OwnerReply => ({
          kind: "removed",
          requestId: command.requestId,
          epoch: setup.epoch,
          removed,
          size: index.size(),
        }));
      }
      case "reset":
        yield* ScopedRef.set(indexRef, empty);
        return yield* native(ack);
      case "save":
        yield* native(() => index.save(`${file}.tmp`));
        yield* files(fs.rename(`${file}.tmp`, file));
        return yield* native(ack);
      case "validate":
        yield* ids(command.ids);
        yield* native(() => index.validateIds([...command.ids]));
        return yield* native(ack);
      case "vector-search": {
        if (command.allowedIds !== undefined) yield* ids(command.allowedIds);
        if (
          command.query.length !== setup.dimensions ||
          !command.query.every(Number.isFinite) ||
          command.k <= 0 ||
          command.k > 4294967295
        )
          return yield* fail("invalid-input");
        return yield* native((): OwnerReply => {
          const allowed = command.allowedIds === undefined ? undefined : [...command.allowedIds];
          const k = Math.min(command.k, index.size());
          const beforeCpu = process.threadCpuUsage();
          const startNs = process.hrtime.bigint();
          const hits = index.search(command.query, k, allowed);
          const endNs = process.hrtime.bigint();
          const cpu = process.threadCpuUsage(beforeCpu);
          return {
            workerCpuUs: cpu.user + cpu.system,
            kind: "vector-hits",
            requestId: command.requestId,
            epoch: setup.epoch,
            ...hits,
            size: index.size(),
            nativeWindow: { startNs: String(startNs), endNs: String(endNs) },
          };
        });
      }
      case "vector-search-controlled": {
        if (command.controlToken === undefined || setup.ownerKey === undefined)
          return yield* fail("invalid-input");
        yield* ids(command.allowedIds);
        if (
          command.query.length !== setup.dimensions ||
          !command.query.every(Number.isFinite) ||
          command.k <= 0 ||
          command.k > 4294967295
        )
          return yield* fail("invalid-input");
        return yield* native((): OwnerReply => {
          const allowed = [...command.allowedIds];
          const result = index.searchControlled(
            command.query,
            command.k,
            command.controlToken!,
            setup.ownerKey!,
            setup.epoch,
            command.requestId,
            allowed,
          );
          return {
            kind: "controlled-result",
            requestId: command.requestId,
            epoch: setup.epoch,
            outcome: result.kind,
            ids: result.ids,
            scores: result.scores,
            nativeMs: result.nativeMs,
            size: index.size(),
          };
        });
      }
      case "memory-search": {
        if (Option.isNone(reader)) return yield* fail("read-failed");
        if (command.controlToken === undefined || setup.ownerKey === undefined)
          return yield* fail("invalid-input");
        const beforeCpu = process.threadCpuUsage();
        const result = yield* native(
          () =>
            reader.value.search(
              index,
              command.input,
              command.controlToken!,
              setup.ownerKey!,
              setup.epoch,
              command.requestId,
            ),
          "read-failed",
        );
        if (result.kind === "read-failed") return yield* fail("read-failed");
        const cpu = process.threadCpuUsage(beforeCpu);
        return {
          workerCpuUs: cpu.user + cpu.system,
          kind: "memory-result" as const,
          requestId: command.requestId,
          epoch: setup.epoch,
          result,
        };
      }
    }
  });

  return { ready: { threadId, size, needsReset }, execute };
});

/**
 * Only the reason crosses IPC: native messages and cache paths stay in this worker. Requests
 * report their own rejection codes; anything else means the index itself failed.
 */
const reported = (error: NativeOwnerFailed) => {
  switch (error.reason) {
    case "epoch-mismatch":
    case "invalid-input":
    case "read-failed":
    case "native-incompatible":
    case "lease-unavailable":
      return NativeOwnerFailed.make({ reason: error.reason });
    default:
      return NativeOwnerFailed.make({ reason: "index-failed" });
  }
};

const handlers = NativeOwnerRpcs.toLayer(
  Effect.gen(function* () {
    // A failed setup is kept and reported by Open, so the host learns why instead of an exit.
    const opened = yield* Effect.exit(owner);
    return NativeOwnerRpcs.of({
      Open: () =>
        opened.pipe(
          Effect.map((current) => current.ready),
          Effect.mapError(reported),
        ),
      Execute: (command) =>
        opened.pipe(
          Effect.flatMap((current) => current.execute(command)),
          Effect.mapError(reported),
        ),
    });
  }),
);

const protocol = RpcServer.layerProtocolWorkerRunner.pipe(Layer.provide(NodeWorkerRunner.layer));
// One command at a time: native calls are synchronous and share the index and reader.
const server = RpcServer.layer(NativeOwnerRpcs, { concurrency: 1 }).pipe(
  Layer.provide(handlers),
  Layer.provide(protocol),
);

await runNativeEffect(Layer.launch(server));
