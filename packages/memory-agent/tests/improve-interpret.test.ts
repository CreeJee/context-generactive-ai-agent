import { it } from "@effect/vitest";
import { NodeCrypto } from "@effect/platform-node";
import { Effect, Fiber, FileSystem, Layer, Option, Queue } from "effect";
import type { LanguageModel } from "effect/ai";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";
import { GlobalConfig } from "../src/config/global-config.ts";
import { StorageRoot } from "../src/config/storage-root.ts";
import { type ImprovementItem, ItemInterpretation } from "../src/improve/contracts.ts";
import { ImprovementInterpreter } from "../src/improve/interpret.ts";
import { ActiveProvider } from "../src/providers/active-provider.ts";
import { AuthConnectionState, type ProviderServices } from "../src/providers/contracts.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import {
  scriptedModel,
  scriptedSource,
  shownScriptedFailure,
  type ScriptedTurn,
} from "../src/testing/scripted-model.ts";
import { withTestPlatform } from "./support/platform.ts";

const item: ImprovementItem = {
  id: "i1",
  repository: "/repo",
  source: "tool_failure",
  title: "Bash: permission denied: Bash",
  count: 3,
  evidence: ["f1"],
  excerpts: ["Permission to use Bash with command sed -n 1p f has been denied."],
  latestAt: null,
};

type Reply = "silent" | "answered";
const answered: ScriptedTurn = {
  text: '{"_tag":"improve","title":"t","problem":"p","rule":"r","change":"c","acceptance":"a"}',
};

/** A signed-in provider whose model answers with `turns` in order. */
const provider = (model: LanguageModel.LanguageModel): ProviderServices => ({
  provider: "openai",
  auth: {
    provider: "openai",
    status: Effect.succeed(AuthConnectionState["signed-in"]({ provider: "openai" })),
    connect: Effect.succeed(AuthConnectionState["signed-in"]({ provider: "openai" })),
    cancel: Effect.succeed(AuthConnectionState["signed-in"]({ provider: "openai" })),
    disconnect: Effect.succeed(AuthConnectionState["signed-out"]({ provider: "openai" })),
  },
  models: {
    provider: "openai",
    list: Effect.succeed([]),
    selected: Effect.succeed({ provider: "openai", model: "test", reasoningEffort: "medium" }),
    acceptsImages: () => Effect.succeed(false),
    cheapestEffort: (selection) => Effect.succeed(selection),
    select: (model) => Effect.succeed({ provider: "openai", model, reasoningEffort: "medium" }),
  },
  runtime: {
    provider: "openai",
    model: () =>
      Effect.succeed({ model, source: scriptedSource, shownFailure: shownScriptedFailure }),
    contextWindow: () => 0,
  },
});

/**
 * The interpreter over a model that replies as `replies` says, in order. A silent reply never
 * streams anything; `asked` takes each call as the model receives it.
 */
const interpreter = Effect.fnUntraced(function* (replies: readonly Reply[]) {
  const fs = yield* FileSystem.FileSystem;
  const storage = yield* fs.makeTempDirectoryScoped({ prefix: "improve-interpret-" });
  const asked = yield* Queue.unbounded<number>();
  const scripted = yield* scriptedModel(({ index }) =>
    Queue.offer(asked, index).pipe(
      Effect.as(replies[index] === "silent" ? { waitFor: Effect.never } : answered),
    ),
  );
  const openai = provider(scripted.model);
  const services = yield* Layer.build(
    ImprovementInterpreter.layer.pipe(
      Layer.provideMerge(ActiveProvider.layer),
      Layer.provideMerge(ProviderRegistry.layer([openai], [openai.runtime])),
      Layer.provideMerge(GlobalConfig.layer.pipe(Layer.provide(StorageRoot.layer(storage)))),
      Layer.provideMerge(NodeCrypto.layer),
    ),
  );
  yield* Effect.provideContext(
    Effect.flatMap(GlobalConfig, (config) => config.update({ provider: "openai", model: "test" })),
    services,
  );
  const { interpret } = yield* Effect.provideContext(
    Effect.flatMap(ImprovementInterpreter, (interpreter) => interpreter.model),
    services,
  );
  /** A call to a silent model, with the clock moved past the silence limit once it is asked. */
  const unanswered = (call: ImprovementItem) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(interpret(call));
      yield* Queue.take(asked);
      yield* TestClock.adjust("61 seconds");
      return yield* Fiber.join(fiber);
    });
  const answeredCall = (call: ImprovementItem) =>
    interpret(call).pipe(Effect.tap(() => Queue.take(asked)));
  return { unanswered, answeredCall };
});

it.effect("a silent model call fails the item, and a second in a row stops the scan", () =>
  Effect.gen(function* () {
    const { unanswered } = yield* interpreter(["silent", "silent"]);
    expect(yield* unanswered(item)).toEqual(
      Option.some(ItemInterpretation.cases.failed.make({ reason: "model_failed" })),
    );
    const stopped = yield* Effect.flip(unanswered(item));
    expect(stopped.reason).toBe("model_unreachable");
  }).pipe(withTestPlatform),
);

it.effect("an answer between failures starts the count again", () =>
  Effect.gen(function* () {
    const { unanswered, answeredCall } = yield* interpreter(["silent", "answered", "silent"]);
    yield* unanswered(item);
    expect(Option.exists(yield* answeredCall(item), ItemInterpretation.guards.interpreted)).toBe(
      true,
    );
    expect(yield* unanswered(item)).toEqual(
      Option.some(ItemInterpretation.cases.failed.make({ reason: "model_failed" })),
    );
  }).pipe(withTestPlatform),
);
