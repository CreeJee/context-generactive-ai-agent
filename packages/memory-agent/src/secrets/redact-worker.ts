// Hiding secrets in stored text, in a worker thread. The sweep reads every node a start has not
// seen yet, and secretlint checks one text after another without giving the event loop a turn: on
// the server's main thread that held up every request meanwhile. In a checkout Node runs this file
// as TypeScript; the executable ships it bundled (`scripts/package.ts`).
// The module itself, not the package index: the index loads every Node service and slows each start.
import * as NodeWorkerRunner from "@effect/platform-node/NodeWorkerRunner";
import { Effect, Layer, Option, Schema } from "effect";
import { RpcServer } from "effect/rpc";
import { runNativeEffect } from "../runtime/native-effect.ts";
import { RedactionFailed, type RedactKind, RedactRpcs } from "./redact-protocol.ts";
import { SecretRedactor } from "./redactor.ts";

const JsonText = Schema.fromJsonString(Schema.Unknown);
const decodeJsonText = Schema.decodeUnknownOption(JsonText);
const encodeJsonText = Schema.encodeEffect(JsonText);

const handlers = RedactRpcs.toLayer(
  Effect.gen(function* () {
    const redactor = yield* SecretRedactor;

    /** A JSON column's text with secrets hidden in its strings, or the text as it was. */
    const hideJson = (text: string) =>
      Option.match(decodeJsonText(text), {
        // Not JSON after all: treat it as text rather than leave it unswept.
        onNone: () => redactor.redactText(text),
        onSome: (value) =>
          redactor.redactResult(value).pipe(
            Effect.flatMap(encodeJsonText),
            Effect.map((out) => ({ text: out, hidden: out === text ? 0 : 1 })),
          ),
      });

    const hide = (kind: RedactKind, texts: readonly string[]) => {
      switch (kind) {
        case "text":
          return Effect.forEach(texts, (text) => redactor.redactText(text));
        case "json":
          return Effect.forEach(texts, hideJson);
      }
    };

    return RedactRpcs.of({
      Redact: ({ kind, texts }) =>
        hide(kind, texts).pipe(
          Effect.mapError(() => RedactionFailed.make({ reason: "redaction-failed" })),
        ),
    });
  }),
);

const protocol = RpcServer.layerProtocolWorkerRunner.pipe(Layer.provide(NodeWorkerRunner.layer));
// One batch at a time: secretlint runs synchronously, and the sweep sends one batch after another.
const server = RpcServer.layer(RedactRpcs, { concurrency: 1 }).pipe(
  Layer.provide(handlers),
  Layer.provide(SecretRedactor.layer),
  Layer.provide(protocol),
);

await runNativeEffect(Layer.launch(server));
