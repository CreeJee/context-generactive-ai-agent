// The import pass in a worker thread. Reading transcripts, hiding secrets in them and writing them
// as nodes is steady CPU work; on the server's main thread it held up every request meanwhile.
// In a checkout Node runs this file as TypeScript; the executable ships it bundled
// (`scripts/package.ts`).
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeWorkerRunner from "@effect/platform-node/NodeWorkerRunner";
import { Clock, Effect, Layer, Path, Queue, Ref, Schema, Stream } from "effect";
import { RpcServer } from "effect/rpc";
import { workerData } from "node:worker_threads";
import { GlobalConfig } from "../config/global-config.ts";
import { StorageRoot } from "../config/storage-root.ts";
import { Database } from "../db/database.ts";
import { Projects } from "../projects/projects.ts";
import { failureTags } from "../runtime/logged-failures.ts";
import { runNativeEffect } from "../runtime/native-effect.ts";
import { SecretRedactor } from "../secrets/redactor.ts";
import { Sessions } from "../sessions/sessions.ts";
import { BulkNodes } from "./bulk.ts";
import { Checkouts } from "./checkouts.ts";
import { TranscriptPass } from "./pass.ts";
import { ImportRpcs, ImportWorkerFailed, ImportWorkerSetup, PassEvent } from "./worker-protocol.ts";

/** Progress is sent at most this often; the last count of a pass always goes out. */
const progressEveryMs = 100;

/**
 * The cause stays in this worker's log; only the reason crosses to the server. `failure` names the
 * failures' tags and reasons, such as the import store step, so the line says where it stopped.
 */
const failed =
  (reason: ImportWorkerFailed["reason"], message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapCause((cause) => Effect.logError(message, { failure: failureTags(cause) }, cause)),
      Effect.mapError(() => ImportWorkerFailed.make({ reason })),
    );

const handlers = ImportRpcs.toLayer(
  Effect.gen(function* () {
    const pass = yield* TranscriptPass;
    return ImportRpcs.of({
      Count: () => pass.counts.pipe(failed("count", "Import count failed")),
      Run: () =>
        Stream.callback<PassEvent, ImportWorkerFailed>((queue) =>
          Effect.gen(function* () {
            const sentAt = yield* Ref.make(0);
            const { progress, counts } = yield* pass
              .run((progress) =>
                Queue.offer(queue, PassEvent.cases.Progress.make(progress)).pipe(
                  Effect.when(
                    Effect.flatMap(Clock.currentTimeMillis, (now) =>
                      Ref.modify(sentAt, (last): [boolean, number] =>
                        now - last < progressEveryMs ? [false, last] : [true, now],
                      ),
                    ),
                  ),
                  Effect.asVoid,
                ),
              )
              .pipe(failed("pass", "Import pass failed"));
            yield* Queue.offer(queue, PassEvent.cases.Finished.make({ ...progress, counts }));
            yield* Queue.end(queue);
          }),
        ),
    });
  }),
);

// Its own connection to the same database; WAL lets the server read while this writes.
const services = Layer.unwrap(
  Effect.gen(function* () {
    const setup = yield* Schema.decodeUnknownEffect(ImportWorkerSetup)(workerData);
    const paths = yield* Path.Path;
    return TranscriptPass.layer(setup.home).pipe(
      Layer.provideMerge(Sessions.layer),
      Layer.provideMerge(
        Layer.mergeAll(
          Projects.layer,
          GlobalConfig.layer,
          BulkNodes.layer,
          SecretRedactor.layer,
          Checkouts.layer,
        ),
      ),
      Layer.provideMerge(
        Layer.merge(
          StorageRoot.layer(setup.storageRoot),
          Database.layer(paths.join(setup.storageRoot, "agent.db")),
        ),
      ),
    );
  }),
).pipe(Layer.provide(NodePath.layer));

const protocol = RpcServer.layerProtocolWorkerRunner.pipe(Layer.provide(NodeWorkerRunner.layer));
const server = RpcServer.layer(ImportRpcs).pipe(
  Layer.provide(handlers),
  Layer.provide(services),
  Layer.provide(protocol),
);

await runNativeEffect(Layer.launch(server));
