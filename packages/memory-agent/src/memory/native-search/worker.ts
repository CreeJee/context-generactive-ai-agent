import { Effect, FileSystem, Layer, Option, Path, Predicate, Queue, Schema } from "effect";
// Node IPC and synchronous native/filesystem calls are confined to this owning worker.
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { parentPort, threadId, workerData } from "node:worker_threads";
import { requireRuntime } from "../../runtime/resources.ts";
import { initializeNodeSqlite } from "../../runtime/node-sqlite-bridge.ts";
import { DatabaseSync } from "node:sqlite";
import { assertDatabaseSchema } from "../../db/database.ts";
import { NativeOwnerFailed, OwnerCommand, OwnerReply, OwnerSetup } from "./worker-protocol.ts";

const fail = (reason: NativeOwnerFailed["reason"]) => NativeOwnerFailed.make({ reason });
const native = <A>(operation: () => A) =>
  Effect.try({ try: operation, catch: () => fail("index-failed") });
const correlation = Schema.Struct({ requestId: Schema.String, epoch: Schema.String });
const canonicalId = Schema.String.check(
  Schema.makeFilter(
    (id) => id.length <= 20 && /^(0|[1-9][0-9]*)$/.test(id) && BigInt(id) <= 18446744073709551615n,
  ),
);
const decodeIds = Schema.decodeUnknownEffect(Schema.Array(canonicalId));

const main = Effect.gen(function* () {
  const services = yield* Layer.build(Layer.merge(NodeFileSystem.layer, NodePath.layer));
  const paths = yield* Effect.provideContext(Path.Path, services);
  const fs = yield* Effect.provideContext(FileSystem.FileSystem, services);
  const files = <A>(operation: Effect.Effect<A, import("effect/PlatformError").PlatformError>) =>
    operation.pipe(Effect.mapError(() => fail("index-failed")));
  const port = parentPort;
  if (port === null || threadId <= 0) return;
  yield* Effect.acquireRelease(Effect.succeed(port), (current) =>
    Effect.sync(() => current.close()),
  );
  const post = (reply: OwnerReply) => native(() => port.postMessage(reply));
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
    yield* Effect.try({
      try: () => {
        const sqlite = new DatabaseSync(setup.databasePath!, { readOnly: true });
        try {
          assertDatabaseSchema(sqlite);
        } finally {
          sqlite.close();
        }
      },
      catch: () => fail("native-incompatible"),
    });
  yield* files(fs.makeDirectory(setup.cacheDirectory, { recursive: true, mode: 0o700 }));
  const binding = yield* Effect.try({
    try: () => {
      const addon = requireRuntime("turbovec");
      const binding = addon.loadTurbovec();
      initializeNodeSqlite(addon.addonPath);
      return binding;
    },
    catch: () => fail("native-incompatible"),
  });
  if (
    !Predicate.isFunction(binding.MemoryReadSession) ||
    !Predicate.isFunction(binding.SearchControl)
  )
    return yield* fail("native-incompatible");
  yield* Effect.acquireRelease(
    Effect.try({
      try: () => new binding.CacheLease(paths.join(setup.cacheDirectory, "writer.lock")),
      catch: () => fail("lease-unavailable"),
    }),
    (lease) => Effect.sync(() => lease.close()),
  );
  const file = paths.join(setup.cacheDirectory, "index.tvim");
  const exists = yield* files(fs.exists(file));
  let needsReset = !exists;
  let index = yield* native(() => {
    if (exists) {
      const saved = binding.VectorIndex.load(file);
      // Metadata belongs to the snapshot; never silently reuse a different vector layout.
      if (saved.dimensions() === setup.dimensions && saved.bits() === setup.bits) return saved;
      // Rebuild must be an explicit host recovery/publication, never a clean empty owner.
      if (setup.recover !== true) throw fail("index-failed");
      needsReset = true;
      return new binding.VectorIndex(setup.dimensions, setup.bits);
    }
    return new binding.VectorIndex(setup.dimensions, setup.bits);
  });
  // The worker owns this read-only connection; env teardown drops it with the index.
  const reader =
    setup.databasePath === undefined
      ? Option.none<InstanceType<typeof binding.MemoryReadSession>>()
      : Option.some(
          yield* Effect.try({
            try: () => new binding.MemoryReadSession(setup.databasePath!),
            catch: () => fail("read-failed"),
          }),
        );
  const size = yield* native(() => index.size());
  yield* post({ kind: "ready", epoch: setup.epoch, threadId, size, needsReset });

  const execute = Effect.fnUntraced(function* (command: OwnerCommand) {
    if (command.epoch !== setup.epoch) return yield* fail("epoch-mismatch");
    const ack = (): OwnerReply => ({
      kind: "ack",
      requestId: command.requestId,
      epoch: setup.epoch,
      size: index.size(),
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
        index = yield* native(() => new binding.VectorIndex(setup.dimensions, setup.bits));
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
        const result = yield* Effect.try({
          try: () =>
            reader.value.search(
              index,
              command.input,
              command.controlToken!,
              setup.ownerKey!,
              setup.epoch,
              command.requestId,
            ),
          catch: () => fail("read-failed"),
        });
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
      case "close":
        yield* native(() => {
          if (Option.isSome(reader)) reader.value.close();
        });
        return {
          kind: "closed",
          requestId: command.requestId,
          epoch: setup.epoch,
        } satisfies OwnerReply;
    }
  });

  // A single scoped consumer serializes native access and asynchronous file publication.
  // Native IPC callbacks only enqueue input; they never execute or fork owner operations.
  type Ingress =
    | { readonly kind: "message"; readonly input: unknown }
    | { readonly kind: "closed" };
  const ingress = yield* Queue.make<Ingress>();
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      // eslint-disable-next-line anti-slop/no-unknown-parameters -- Node IPC input is decoded in the owner loop.
      const receive = (input: unknown) => Queue.offerUnsafe(ingress, { kind: "message", input });
      const closed = () => Queue.offerUnsafe(ingress, { kind: "closed" });
      port.on("message", receive);
      port.on("close", closed);
      port.on("messageerror", closed);
      return { receive, closed };
    }),
    ({ receive, closed }) =>
      Effect.sync(() => {
        port.off("message", receive);
        port.off("close", closed);
        port.off("messageerror", closed);
      }),
  );
  while (true) {
    const event = yield* Queue.take(ingress);
    switch (event.kind) {
      case "closed":
        return;
      case "message": {
        const input = event.input;
        const terminal = yield* Schema.decodeUnknownEffect(OwnerCommand)(input).pipe(
          Effect.mapError(() => fail("invalid-input")),
          Effect.flatMap(execute),
          Effect.flatMap((reply) => post(reply).pipe(Effect.as(reply.kind === "closed"))),
          Effect.catchTag("NativeOwnerFailed", (error) => {
            const identity = Schema.decodeUnknownOption(correlation)(input);
            return Effect.gen(function* () {
              const matching = Option.getOrElse(identity, () => ({
                requestId: "",
                epoch: setup.epoch,
              }));
              const code =
                error.reason === "epoch-mismatch" ||
                error.reason === "invalid-input" ||
                error.reason === "read-failed" ||
                error.reason === "native-incompatible"
                  ? error.reason
                  : "index-failed";
              yield* post({ kind: "failed", ...matching, code });
              return code !== "invalid-input" && code !== "epoch-mismatch";
            });
          }),
        );
        if (terminal) return;
        break;
      }
    }
  }
});

// Startup errors contain only protocol codes; no native messages or cache paths cross IPC.
void Effect.runPromiseExit(
  main.pipe(
    Effect.catchTag("NativeOwnerFailed", (error) =>
      Effect.sync(() => {
        parentPort?.postMessage({
          kind: "failed",
          requestId: "",
          epoch: Schema.decodeUnknownOption(OwnerSetup)(workerData).pipe(
            Option.map((setup) => setup.epoch),
            Option.getOrElse(() => ""),
          ),
          code:
            error.reason === "native-incompatible"
              ? "native-incompatible"
              : error.reason === "lease-unavailable"
                ? "lease-unavailable"
                : error.reason === "invalid-input"
                  ? "invalid-input"
                  : "index-failed",
        } satisfies OwnerReply);
        parentPort?.close();
      }),
    ),
    Effect.scoped,
  ),
);
