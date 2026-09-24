// Hiding secrets in stored text, in a worker thread. The sweep reads every node a start has not
// seen yet, and secretlint checks one text after another without giving the event loop a turn: on
// the server's main thread that held up every request meanwhile. In a checkout Node runs this file
// as TypeScript; the executable ships it bundled (`scripts/package.ts`).
import { parentPort } from "node:worker_threads";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { RedactRequest, type RedactReply } from "./redact-protocol.ts";
import { SecretRedactor, type Redaction, type SecretRedactionFailed } from "./redactor.ts";

const port = parentPort;
if (!port) throw new Error("the redaction worker runs only as a worker thread");
const decodeRequest = Schema.decodeUnknownSync(RedactRequest);
const decodeJsonText = Schema.decodeUnknownOption(Schema.parseJson());

const redactor = Effect.runSync(Effect.provide(SecretRedactor, SecretRedactor.layer));

/** A JSON column's text with secrets hidden in its strings, or the text as it was. */
const hideJson = (text: string): Effect.Effect<Redaction, SecretRedactionFailed> =>
  Option.match(decodeJsonText(text), {
    // Not JSON after all: treat it as text rather than leave it unswept.
    onNone: () => redactor.redactText(text),
    onSome: (value) =>
      Effect.map(redactor.redactResult(value), (redacted) => {
        const out = JSON.stringify(redacted);
        return { text: out, hidden: out === text ? 0 : 1 };
      }),
  });

const hide = (request: RedactRequest) => {
  switch (request.kind) {
    case "text":
      return Effect.forEach(request.texts, (text) => redactor.redactText(text));
    case "json":
      return Effect.forEach(request.texts, hideJson);
  }
};

const reasonOf = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message || error.name : String(error);
};

port.on("message", (message) => {
  const request = decodeRequest(message);
  void Effect.runPromiseExit(hide(request)).then((exit) =>
    port.postMessage(
      Exit.match(exit, {
        onSuccess: (redactions): RedactReply => ({ id: request.id, kind: "redacted", redactions }),
        onFailure: (cause): RedactReply => ({
          id: request.id,
          kind: "failed",
          reason: reasonOf(cause),
        }),
      }),
    ),
  );
});
