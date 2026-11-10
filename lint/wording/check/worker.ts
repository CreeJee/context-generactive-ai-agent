// Worker thread behind the lint rule `wording/content`. Oxlint rules run synchronously, while reading
// messages (the native extractor) and Kiwi are asynchronous, so the rule posts a file here and
// blocks on a shared signal until the answer is on its port (`../rules/checker.ts`).
import { workerData, parentPort } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";

import { Array as Arr, Effect } from "effect";

import { checkMessages } from "./check.ts";
import type { Finding } from "./check.ts";
import { sourceMessages } from "./messages.ts";
import type { SourceMessage } from "./messages.ts";
import { Morphemes, morphemesLive } from "./morphemes.ts";

/** A file the rule asks about. */
export interface CheckRequest {
  readonly file: string;
  readonly source: string;
}

/** What the worker answers: the findings, or why the file could not be checked. */
export type CheckReply =
  | { readonly _tag: "Checked"; readonly findings: ReadonlyArray<Finding<SourceMessage>> }
  | { readonly _tag: "Unchecked"; readonly reason: string };

/** What the rule hands the worker when it starts it. */
export interface CheckerChannel {
  readonly signal: Int32Array;
  readonly port: MessagePort;
}

// SAFETY: `../rules/checker.ts` is the only code that starts this worker, always with a
// CheckerChannel as its workerData.
const { signal, port } = workerData as CheckerChannel;

// Kiwi loads on the first file that holds a Korean message, once per lint run; a file without one
// never waits for it.
const morphemes = Effect.runSync(
  Effect.cached(Effect.provide(Effect.service(Morphemes), morphemesLive)),
);

const check = ({ file, source }: CheckRequest) =>
  sourceMessages(file, source).pipe(
    Effect.flatMap((messages) =>
      Arr.isReadonlyArrayEmpty(messages)
        ? Effect.succeed(Arr.empty<Finding<SourceMessage>>())
        : Effect.provideServiceEffect(checkMessages(messages), Morphemes, morphemes),
    ),
    Effect.map((findings): CheckReply => ({ _tag: "Checked", findings })),
    Effect.catch((error) =>
      Effect.succeed<CheckReply>({ _tag: "Unchecked", reason: error.message }),
    ),
  );

const answer = (reply: CheckReply) => {
  port.postMessage(reply);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
};

parentPort?.on("message", (request: CheckRequest) => {
  void Effect.runPromise(check(request)).then(answer, (cause: unknown) =>
    answer({ _tag: "Unchecked", reason: String(cause) }),
  );
});
