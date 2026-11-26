import {
  Array as EffectArray,
  Clock,
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  Predicate,
  Schema,
  type Scope,
} from "effect";
import { RpcServer } from "effect/rpc";
// Synchronous native/filesystem calls are confined to this owning worker.
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeWorkerRunner from "@effect/platform-node/NodeWorkerRunner";
import { threadId, workerData } from "node:worker_threads";
import { workerObservabilityLayer } from "../../runtime/worker-observability.ts";
import { runNativeEffect } from "../../runtime/native-effect.ts";
import { requireRuntime } from "../../runtime/resources.ts";
import { initializeNodeSqlite } from "../../runtime/node-sqlite-bridge.ts";
import { DatabaseSync } from "node:sqlite";
import { assertDatabaseSchema } from "../../db/database.ts";
import { readCoverage } from "./coverage.ts";
import {
  NativeOwnerFailed,
  NativeOwnerRpcs,
  OwnerCommand,
  OwnerReply,
  type OwnerReady,
  type OwnerSetup,
  type ReaderSetup,
  WorkerSetup,
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

/**
 * Child spans of the current span for the steps a native call timed itself, laid end to end from
 * `start`. The addon cannot reach the tracer, so it reports each step's milliseconds instead.
 */
const stepSpans = Effect.fnUntraced(function* (
  start: bigint,
  steps: ReadonlyArray<readonly [name: string, ms: number]>,
) {
  const tracer = yield* Effect.tracer;
  const parent = yield* Effect.option(Effect.currentSpan);
  const [, windows] = EffectArray.mapAccum(steps, start, (from, [name, ms]) => {
    const to = from + BigInt(Math.round(ms * 1_000_000));
    return [to, { name, from, to }] as const;
  });
  yield* Effect.forEach(windows, ({ name, from, to }) =>
    Effect.sync(() =>
      tracer
        .span({
          name,
          parent,
          annotations: Context.empty(),
          links: [],
          startTime: from,
          kind: "internal",
          root: Option.isNone(parent),
          sampled: Option.match(parent, { onNone: () => true, onSome: (span) => span.sampled }),
        })
        .end(to, Exit.void),
    ),
  );
});

/** A native call measured by itself: its span, and the spans of the steps it timed. */
const timedNative = <A>(
  name: string,
  attributes: Readonly<Record<string, number>>,
  call: Effect.Effect<A, NativeOwnerFailed>,
  steps: (result: A) => ReadonlyArray<readonly [name: string, ms: number]>,
) =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeNanos;
    const result = yield* call;
    yield* stepSpans(start, steps(result));
    return result;
  }).pipe(Effect.withSpan(name, { attributes }));

const files = <A>(operation: Effect.Effect<A, import("effect/PlatformError").PlatformError>) =>
  operation.pipe(
    Effect.mapError((cause) => NativeOwnerFailed.make({ reason: "index-failed", cause })),
  );

/** The addon, its node:sqlite bridge set up for this worker. */
const loadBinding = Effect.gen(function* () {
  const addon = yield* requireRuntime("turbovec").pipe(
    Effect.mapError((cause) => NativeOwnerFailed.make({ reason: "native-incompatible", cause })),
  );
  const binding = yield* native(() => {
    const binding = addon.loadTurbovec();
    initializeNodeSqlite(addon.addonPath);
    return binding;
  }, "native-incompatible");
  if (
    !Predicate.isFunction(binding.MemoryReadSession) ||
    !Predicate.isFunction(binding.SearchControl)
  )
    return yield* fail("native-incompatible");
  return binding;
});
type Binding = Effect.Success<typeof loadBinding>;

/**
 * The worker's own read-only connection: the schema check before anything else, then the
 * coverage counts beside each read. Scope closure closes it.
 */
const openCounter = (databasePath: string) =>
  Effect.acquireRelease(
    native(() => new DatabaseSync(databasePath, { readOnly: true }), "native-incompatible"),
    (sqlite) => Effect.sync(() => sqlite.close()),
  ).pipe(Effect.tap((sqlite) => native(() => assertDatabaseSchema(sqlite), "native-incompatible")));

/** The worker's read session; Scope closure closes it before the index it reads. */
const openReader = (binding: Binding, databasePath: string) =>
  Effect.acquireRelease(
    native(() => new binding.MemoryReadSession(databasePath), "read-failed"),
    (session) => Effect.sync(() => session.close()),
  );

/**
 * The reads a worker serves, the owner and a reader alike: a memory read over `index` and
 * `lexical`, and the coverage count beside it.
 */
const reads = (
  setup: Pick<OwnerSetup, "epoch" | "ownerKey">,
  index: InstanceType<Binding["VectorIndex"]>,
  lexical: Option.Option<InstanceType<Binding["LexicalIndex"]>>,
  reader: Option.Option<InstanceType<Binding["MemoryReadSession"]>>,
  counter: Option.Option<DatabaseSync>,
) => ({
  "memory-search": (command: (typeof OwnerCommand.cases)["memory-search"]["Type"]) =>
    Effect.gen(function* () {
      const session = yield* Effect.fromOption(reader, () => fail("read-failed"));
      if (command.controlToken === undefined || setup.ownerKey === undefined)
        return yield* fail("invalid-input");
      const beforeCpu = process.threadCpuUsage();
      const result = yield* native(
        () =>
          session.search(
            index,
            Option.getOrNull(lexical),
            command.input,
            command.controlToken!,
            setup.ownerKey!,
            setup.epoch,
            command.requestId,
          ),
        "read-failed",
      ).pipe(Effect.withSpan("MemoryReadSession.search"));
      if (result.kind === "read-failed") return yield* fail("read-failed");
      const cpu = process.threadCpuUsage(beforeCpu);
      return OwnerReply.cases["memory-result"].make({
        workerCpuUs: cpu.user + cpu.system,
        requestId: command.requestId,
        epoch: setup.epoch,
        result,
      });
    }),
  "memory-coverage": (command: (typeof OwnerCommand.cases)["memory-coverage"]["Type"]) =>
    Effect.gen(function* () {
      const sqlite = yield* Effect.fromOption(counter, () => fail("read-failed"));
      const coverage = yield* readCoverage(sqlite, command.input).pipe(
        Effect.mapError((cause) => NativeOwnerFailed.make({ reason: "read-failed", cause })),
        Effect.withSpan("NativeWorker.readCoverage"),
      );
      return OwnerReply.cases["coverage-result"].make({
        requestId: command.requestId,
        epoch: setup.epoch,
        coverage,
      });
    }),
});

/** A started worker: what it reports to Open, and how it runs each command. */
type Started = {
  readonly ready: OwnerReady;
  readonly execute: (command: OwnerCommand) => Effect.Effect<OwnerReply, NativeOwnerFailed>;
};

const checkEpoch = (command: OwnerCommand, epoch: string) =>
  Effect.when(Effect.fail(fail("epoch-mismatch")), Effect.succeed(command.epoch !== epoch));

/**
 * A reader beside the owner: it searches the indexes the owner shared under its key, in place,
 * and takes no other command. Scope closure releases its views, never the owner's indexes.
 */
const readerWorker = Effect.fnUntraced(function* (
  setup: ReaderSetup,
): Effect.fn.Return<Started, NativeOwnerFailed, Scope.Scope> {
  const counter = yield* openCounter(setup.databasePath);
  const binding = yield* loadBinding;
  const index = yield* Effect.acquireRelease(
    native(() => binding.VectorIndex.attach(setup.ownerKey)),
    (index) => Effect.sync(() => index.close()),
  );
  if ((yield* native(() => index.dimensions())) !== setup.dimensions)
    return yield* fail("invalid-input");
  const lexical = setup.lexical
    ? Option.some(
        yield* Effect.acquireRelease(
          native(() => binding.LexicalIndex.attach(setup.ownerKey)),
          (index) => Effect.sync(() => index.close()),
        ),
      )
    : Option.none();
  const reader = yield* openReader(binding, setup.databasePath);
  const served = reads(setup, index, lexical, Option.some(reader), Option.some(counter));
  const refused = () => Effect.fail(fail("invalid-input"));
  const execute = Effect.fnUntraced(function* (command: OwnerCommand) {
    yield* checkEpoch(command, setup.epoch);
    return yield* OwnerCommand.match(command, {
      ...served,
      add: refused,
      remove: refused,
      reset: refused,
      save: refused,
      validate: refused,
      "vector-search": refused,
      "vector-search-controlled": refused,
      "lexical-apply": refused,
      "lexical-reset": refused,
    });
  });
  const lexicalReady = yield* Effect.transposeOption(
    Option.map(lexical, (index) => native(() => ({ instance: index.instance() }))),
  );
  return {
    ready: {
      threadId,
      size: yield* native(() => index.size()),
      needsReset: false,
      lexical: Option.getOrUndefined(lexicalReady),
    },
    execute,
  };
});

/** The owner's scoped resources and its command executor; Scope closure releases them. */
const ownerWorker = Effect.fnUntraced(function* (
  setup: OwnerSetup,
): Effect.fn.Return<Started, NativeOwnerFailed, Scope.Scope> {
  const services = yield* Layer.build(Layer.merge(NodeFileSystem.layer, NodePath.layer));
  const paths = yield* Effect.provideContext(Path.Path, services);
  const fs = yield* Effect.provideContext(FileSystem.FileSystem, services);
  if (
    setup.dimensions <= 0 ||
    setup.dimensions % 8 !== 0 ||
    setup.dimensions > 4294967295 ||
    ![1, 2, 4, 8].includes(setup.bits)
  )
    return yield* fail("invalid-input");
  const counter = yield* Effect.transposeOption(
    Option.map(Option.fromUndefinedOr(setup.databasePath), openCounter),
  );
  yield* files(fs.makeDirectory(setup.cacheDirectory, { recursive: true, mode: 0o700 }));
  const binding = yield* loadBinding;
  yield* Effect.acquireRelease(
    native(
      () => new binding.CacheLease(paths.join(setup.cacheDirectory, "writer.lock")),
      "lease-unavailable",
    ),
    (lease) => Effect.sync(() => lease.close()),
  );
  const file = paths.join(setup.cacheDirectory, "index.tvim");
  const exists = yield* files(fs.exists(file));
  // The index is released when the worker's Scope closes, not at GC. Readers attached to it keep
  // it until they close too.
  const index = yield* Effect.acquireRelease(
    native(() =>
      exists
        ? binding.VectorIndex.load(file)
        : new binding.VectorIndex(setup.dimensions, setup.bits),
    ),
    (index) => Effect.sync(() => index.close()),
  );
  // Metadata belongs to the snapshot; never silently reuse a different vector layout.
  const compatible =
    exists &&
    (yield* native(() => index.dimensions() === setup.dimensions && index.bits() === setup.bits));
  // Rebuild must be an explicit host recovery/publication, never a clean empty owner.
  if (exists && !compatible && setup.recover !== true) return yield* fail("index-failed");
  const needsReset = !compatible;
  if (exists && !compatible) yield* native(() => index.reset(setup.dimensions, setup.bits));
  // The worker owns this read-only connection; Scope closure closes it before the index.
  const reader = yield* Effect.transposeOption(
    Option.map(Option.fromUndefinedOr(setup.databasePath), (databasePath) =>
      openReader(binding, databasePath),
    ),
  );
  // The vector lease above already keeps a second owner of this storage root out; Tantivy's own
  // writer lock guards the folder as well. The index is closed before the worker exits.
  const lexical = yield* Effect.transposeOption(
    Option.map(Option.fromUndefinedOr(setup.lexicalDirectory), (directory) =>
      Effect.acquireRelease(
        native(() => binding.LexicalIndex.open(directory, setup.recover === true)),
        (index) => Effect.sync(() => index.close()),
      ),
    ),
  );
  /**
   * Reads which node and conversation each of `ids` (every vector when omitted) belongs to: reads
   * build their allowlist from that instead of from SQLite (docs/vector-index-design.md, step 1).
   */
  const attachOwners = (ids?: readonly string[]) =>
    Effect.transposeOption(
      Option.map(reader, (session) =>
        native(() => index.attachOwners(session, ids === undefined ? undefined : [...ids])).pipe(
          Effect.withSpan("VectorIndex.attachOwners", {
            attributes: { vectors: ids?.length ?? index.size() },
          }),
        ),
      ),
    );
  yield* attachOwners();
  // Readers find the indexes by the owner's private key once they are complete.
  yield* Effect.transposeOption(
    Option.map(Option.fromUndefinedOr(setup.ownerKey), (key) =>
      native(() => {
        index.share(key);
        Option.map(lexical, (lexical) => lexical.share(key));
      }),
    ),
  );
  const size = yield* native(() => index.size());
  const lexicalReady = yield* Effect.transposeOption(
    Option.map(lexical, (index) => native(() => ({ instance: index.instance() }))),
  );
  const served = reads(setup, index, lexical, reader, counter);

  const execute = Effect.fnUntraced(function* (command: OwnerCommand) {
    yield* checkEpoch(command, setup.epoch);
    const ack = () =>
      OwnerReply.cases.ack.make({
        requestId: command.requestId,
        epoch: setup.epoch,
        size: index.size(),
      });
    const ids = (values: readonly string[]) =>
      decodeIds(values).pipe(Effect.mapError(() => fail("invalid-input")));
    const lexicalIndex = Effect.fromOption(lexical, () => fail("invalid-input"));
    const lexicalAck = (size: number) =>
      OwnerReply.cases["lexical-ack"].make({
        requestId: command.requestId,
        epoch: setup.epoch,
        size,
      });
    return yield* OwnerCommand.match(command, {
      add: (command) =>
        Effect.gen(function* () {
          yield* ids(command.ids);
          if (
            command.vectors.length !== command.ids.length * setup.dimensions ||
            !command.vectors.every(Number.isFinite)
          )
            return yield* fail("invalid-input");
          yield* native(() => index.add(command.vectors, [...command.ids])).pipe(
            Effect.withSpan("VectorIndex.add", { attributes: { vectors: command.ids.length } }),
          );
          // The chunk rows are committed before the add, so the reader sees them.
          yield* attachOwners(command.ids);
          return yield* native(ack);
        }),
      remove: (command) =>
        Effect.gen(function* () {
          yield* ids(command.ids);
          const removed = yield* native(() =>
            command.ids.reduce((count, id) => (index.remove(id) ? count + 1 : count), 0),
          ).pipe(
            Effect.withSpan("VectorIndex.remove", { attributes: { ids: command.ids.length } }),
          );
          return yield* native(() =>
            OwnerReply.cases.removed.make({
              requestId: command.requestId,
              epoch: setup.epoch,
              removed,
              size: index.size(),
            }),
          );
        }),
      // In place, so the readers attached to the index see the empty one too.
      reset: () =>
        native(() => index.reset(setup.dimensions, setup.bits)).pipe(Effect.andThen(native(ack))),
      save: () =>
        Effect.gen(function* () {
          const vectors = yield* native(() => index.size());
          // Only the rows and removals since the last save reach the file, not the whole index.
          yield* native(() => index.save(file)).pipe(
            Effect.withSpan("VectorIndex.save", { attributes: { vectors } }),
          );
          return yield* native(ack);
        }),
      validate: (command) =>
        Effect.gen(function* () {
          yield* ids(command.ids);
          yield* native(() => index.validateIds([...command.ids])).pipe(
            Effect.withSpan("VectorIndex.validateIds", { attributes: { ids: command.ids.length } }),
          );
          return yield* native(ack);
        }),
      "vector-search": (command) =>
        Effect.gen(function* () {
          yield* Effect.transposeOption(
            Option.map(Option.fromUndefinedOr(command.allowedIds), ids),
          );
          if (
            command.query.length !== setup.dimensions ||
            !command.query.every(Number.isFinite) ||
            command.k <= 0 ||
            command.k > 4294967295
          )
            return yield* fail("invalid-input");
          return yield* native(() => {
            const allowed = command.allowedIds === undefined ? undefined : [...command.allowedIds];
            const k = Math.min(command.k, index.size());
            const beforeCpu = process.threadCpuUsage();
            const startNs = process.hrtime.bigint();
            const hits = index.search(command.query, k, allowed);
            const endNs = process.hrtime.bigint();
            const cpu = process.threadCpuUsage(beforeCpu);
            return OwnerReply.cases["vector-hits"].make({
              workerCpuUs: cpu.user + cpu.system,
              requestId: command.requestId,
              epoch: setup.epoch,
              ...hits,
              size: index.size(),
              nativeWindow: { startNs: String(startNs), endNs: String(endNs) },
            });
          }).pipe(Effect.withSpan("VectorIndex.search", { attributes: { k: command.k } }));
        }),
      "vector-search-controlled": (command) =>
        Effect.gen(function* () {
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
          return yield* native(() => {
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
            return OwnerReply.cases["controlled-result"].make({
              requestId: command.requestId,
              epoch: setup.epoch,
              outcome: result.kind,
              ids: result.ids,
              scores: result.scores,
              nativeMs: result.nativeMs,
              size: index.size(),
            });
          }).pipe(
            Effect.withSpan("VectorIndex.searchControlled", { attributes: { k: command.k } }),
          );
        }),
      ...served,
      "lexical-apply": (command) =>
        Effect.gen(function* () {
          const index = yield* lexicalIndex;
          if (
            !command.documents.every((document) => document.seq >= 0) ||
            !command.removed.every((seq) => seq >= 0)
          )
            return yield* fail("invalid-input");
          const applied = yield* timedNative(
            "LexicalIndex.apply",
            { documents: command.documents.length, removed: command.removed.length },
            native(() =>
              index.apply(
                command.documents.map((document) => ({ ...document })),
                [...command.removed],
              ),
            ),
            (took) => [
              ["LexicalIndex.apply.analyze", took.analyzeMs],
              ["LexicalIndex.apply.write", took.writeMs],
              ["LexicalIndex.apply.commit", took.commitMs],
              ["LexicalIndex.apply.reload", took.reloadMs],
            ],
          );
          return lexicalAck(applied.size);
        }),
      "lexical-reset": (command) =>
        Effect.gen(function* () {
          const index = yield* lexicalIndex;
          yield* native(() => index.reset(command.instance)).pipe(
            Effect.withSpan("LexicalIndex.reset"),
          );
          return yield* native(() => lexicalAck(index.size()));
        }),
    });
  });

  return {
    ready: { threadId, size, needsReset, lexical: Option.getOrUndefined(lexicalReady) },
    execute,
  };
});

/**
 * Only the reason crosses IPC: native messages and cache paths stay in this worker. Requests
 * report their own rejection codes; anything else means the index itself failed.
 */
const reported = (error: NativeOwnerFailed) =>
  Match.value(error.reason).pipe(
    Match.whenOr(
      "epoch-mismatch",
      "invalid-input",
      "read-failed",
      "native-incompatible",
      "lease-unavailable",
      fail,
    ),
    Match.orElse(() => fail("index-failed")),
  );

const handlers = NativeOwnerRpcs.toLayer(
  Effect.gen(function* () {
    // A failed setup is kept and reported by Open, so the host learns why instead of an exit.
    const opened = yield* Effect.exit(
      Schema.decodeUnknownEffect(WorkerSetup)(workerData).pipe(
        Effect.mapError(() => fail("invalid-input")),
        Effect.flatMap((setup) =>
          setup.kind === "reader" ? readerWorker(setup) : ownerWorker(setup),
        ),
      ),
    );
    return NativeOwnerRpcs.of({
      Open: () =>
        opened.pipe(
          Effect.map((current) => current.ready),
          Effect.mapError(reported),
        ),
      // Named by the command, so a trace tells a slow save from a slow add.
      Execute: (command) =>
        opened.pipe(
          Effect.flatMap((current) => current.execute(command)),
          Effect.mapError(reported),
          Effect.withSpan(`NativeWorker.${command._tag}`),
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

// The worker's failed spans go to the owner thread, which puts them in defect notices and
// reports under the run that caused them.
await runNativeEffect(Layer.launch(Layer.provide(server, workerObservabilityLayer)));
