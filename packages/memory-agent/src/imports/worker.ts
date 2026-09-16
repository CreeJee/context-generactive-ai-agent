// The import pass in a worker thread. Reading transcripts, hiding secrets in them and writing them
// as nodes is steady CPU work; on the server's main thread it held up every request meanwhile.
// In a checkout Node runs this file as TypeScript; the executable ships it bundled
// (`scripts/package.ts`).
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Schema } from "effect";
import { GlobalConfig } from "../config/global-config.ts";
import { StorageRoot } from "../config/storage-root.ts";
import { Database } from "../db/database.ts";
import { Projects } from "../projects/projects.ts";
import { SecretRedactor } from "../secrets/redactor.ts";
import { Sessions } from "../sessions/sessions.ts";
import { BulkNodes } from "./bulk.ts";
import { TranscriptPass } from "./pass.ts";
import {
  ImportWorkerRequest,
  ImportWorkerSetup,
  type ImportWorkerReply,
} from "./worker-protocol.ts";

/** Progress is sent at most this often; the last count of a pass always goes out. */
const progressEveryMs = 100;

const port = parentPort;
if (!port) throw new Error("the import worker runs only as a worker thread");
const setup = Schema.decodeUnknownSync(ImportWorkerSetup)(workerData);
const decodeRequest = Schema.decodeUnknownSync(ImportWorkerRequest);

// Its own connection to the same database; WAL lets the server read while this writes.
const runtime = ManagedRuntime.make(
  TranscriptPass.layer(setup.home).pipe(
    Layer.provideMerge(Sessions.layer),
    Layer.provideMerge(
      Layer.mergeAll(Projects.layer, GlobalConfig.layer, BulkNodes.layer, SecretRedactor.layer),
    ),
    Layer.provideMerge(
      Layer.merge(
        StorageRoot.layer(setup.storageRoot),
        Database.layer(join(setup.storageRoot, "agent.db")),
      ),
    ),
  ),
);

const post = (reply: ImportWorkerReply) => port.postMessage(reply);

const failed = (id: number, cause: Cause.Cause<unknown>): ImportWorkerReply => {
  const error = Cause.squash(cause);
  return {
    id,
    kind: "failed",
    reason: error instanceof Error ? error.message || error.name : String(error),
  };
};

const count = (id: number) =>
  runtime.runPromiseExit(Effect.flatMap(TranscriptPass, (pass) => pass.counts)).then((exit) =>
    post(
      Exit.match(exit, {
        onSuccess: (counts): ImportWorkerReply => ({ id, kind: "counts", counts }),
        onFailure: (cause) => failed(id, cause),
      }),
    ),
  );

const run = (id: number) => {
  let sentAt = 0;
  return runtime
    .runPromiseExit(
      Effect.flatMap(TranscriptPass, (pass) =>
        pass.run((progress) => {
          const now = Date.now();
          if (now - sentAt < progressEveryMs) return;
          sentAt = now;
          post({ id, kind: "progress", ...progress });
        }),
      ),
    )
    .then((exit) =>
      post(
        Exit.match(exit, {
          onSuccess: ({ progress, counts }): ImportWorkerReply => ({
            id,
            kind: "finished",
            ...progress,
            counts,
          }),
          onFailure: (cause) => failed(id, cause),
        }),
      ),
    );
};

port.on("message", (message) => {
  const request = decodeRequest(message);
  switch (request.kind) {
    case "count":
      void count(request.id);
      return;
    case "run":
      void run(request.id);
      return;
  }
});
