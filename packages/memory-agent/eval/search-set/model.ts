/**
 * The model that writes round questions and grades search results: the one the user selected in the
 * app (copied from their config.json; keys stay in the keychain), or another model of the same
 * provider by id. The app's services for it run on their own storage folder inside the copy, so
 * nothing is written to the user's storage or to the copy's database.
 */
import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { defaultStorageRoot } from "../../src/config/storage-root.ts";
import { memoryAgentLayer } from "../../src/layers.ts";
import { singleAnswer } from "../../src/model/single-call.ts";
import { ActiveProvider } from "../../src/providers/active-provider.ts";
import { AuthConnectionState } from "../../src/providers/contracts.ts";
import { path } from "../../src/runtime/synchronous-path.ts";
import { fakeEmbedderLayer } from "../../src/testing/fake-embedder.ts";
import { fakeMorphLayer } from "../../src/testing/fake-morph.ts";
import { setFiles } from "./files.ts";

/** The selected model cannot be asked: no model is selected or its provider is not signed in. */
export class ModelUnavailable extends Schema.TaggedError<
  ModelUnavailable,
  { readonly brand: unique symbol }
>()("ModelUnavailable", { reason: Schema.String }) {}

/** One call took longer than this: a local server under load can stall. */
const callTimeout = "3 minutes";

/** Which model to ask: the app's selection, or another model of its provider by id. */
export interface ModelChoice {
  readonly storage: string;
  readonly model: Option.Option<string>;
}

/** The app's services for model calls, on a storage folder of their own inside the copy. */
const modelServices = Effect.fn("searchSet.modelServices")(function* (storage: string) {
  const fs = yield* FileSystem.FileSystem;
  const root = path.join(setFiles(storage).root, "model-storage");
  const home = path.join(root, "home");
  yield* fs.makeDirectory(home, { recursive: true });
  yield* fs.copyFile(
    path.join(yield* defaultStorageRoot, "config.json"),
    path.join(root, "config.json"),
  );
  return yield* Layer.build(
    memoryAgentLayer(root, {
      embedder: fakeEmbedderLayer,
      morphAnalyzer: fakeMorphLayer,
      interpretAutomatically: false,
      summarizeAutomatically: false,
      importsHome: home,
      importsWatching: false,
      sweepSecrets: false,
      skillsHome: home,
    }),
  );
});

const make = Effect.fn("searchSet.EvalModel.make")(function* ({ storage, model }: ModelChoice) {
  const services = yield* modelServices(storage);
  return yield* Effect.provideContext(
    Effect.gen(function* () {
      const active = yield* ActiveProvider;
      const selected = yield* Effect.fromNullishOr(yield* active.selected).pipe(
        Effect.mapError(() => ModelUnavailable.make({ reason: "no model is selected in the app" })),
      );
      const selection = Option.match(model, {
        onNone: () => selected,
        onSome: (id) => ({ ...selected, model: id }),
      });
      const auth = yield* active.auth(selection);
      if (!AuthConnectionState.$is("signed-in")(auth))
        return yield* ModelUnavailable.make({ reason: `${selection.provider} is not signed in` });
      const runtime = yield* active.runtime(selection);
      const random = yield* SecureRandom.SecureRandom;
      return {
        name: `${selection.provider}/${selection.model}`,
        /**
         * The model's answer to one question under one system prompt. A failed or timed-out call
         * gives none: the caller leaves that work for a later run.
         */
        ask: (system: string, prompt: string) =>
          Effect.flatMap(random.uuidV4(), (threadId) =>
            singleAnswer({ runtime, selection, threadId, system, prompt }),
          ).pipe(
            Effect.map((answer) => answer.text),
            Effect.option,
            Effect.timeoutOption(callTimeout),
            Effect.map(Option.flatten),
            Effect.provideContext(services),
          ),
      };
    }),
    services,
  );
});

/** The model the set's steps ask, with the app's services it needs kept until the scope closes. */
export class EvalModel extends Context.Service<
  EvalModel,
  Effect.Success<ReturnType<typeof make>>
>()("memory-agent/eval/search-set/model/EvalModel") {
  static readonly layer = (choice: ModelChoice) => Layer.effect(EvalModel, make(choice));
}

/** The first JSON object in a model's answer, decoded; none when there is no readable one. */
export const answerObject =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (text: string): Option.Option<S["Type"]> =>
    Option.flatMap(
      Option.fromNullishOr(text.match(/\{[\s\S]*\}/u)?.[0]),
      Schema.decodeUnknownOption(Schema.fromJsonString(schema)),
    );
