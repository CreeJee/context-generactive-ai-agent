import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { Effect, FileSystem, Layer, Option } from "effect";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { GlobalConfig } from "./global-config.ts";
import {
  defaultKanbanConcurrency,
  KanbanSettings,
  KanbanSettingsRefused,
} from "./kanban-settings.ts";
import { StorageRoot } from "./storage-root.ts";

/** Builds a layer in the test's scope and provides what it made. */
const provideLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(program: Effect.Effect<A, E, R>) =>
    Effect.flatMap(Layer.build(layer), (context) => Effect.provideContext(program, context));

const withSettings = <A, E>(cores: number, program: Effect.Effect<A, E, KanbanSettings>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const storage = yield* fs.makeTempDirectoryScoped();
    const layer = KanbanSettings.layer(cores).pipe(
      Layer.provide(GlobalConfig.layer),
      Layer.provide(StorageRoot.layer(storage)),
    );
    return yield* provideLayer(layer)(program);
  }).pipe(provideLayer(NodeFileSystem.layer), Effect.scoped);

it("defaults to half the cores, between 1 and 4", () => {
  expect([1, 2, 6, 8, 64].map(defaultKanbanConcurrency)).toEqual([1, 1, 3, 4, 4]);
});

it.effect("keeps a user value, refuses one out of range and resets to the default", () =>
  withSettings(
    6,
    Effect.gen(function* () {
      const settings = yield* KanbanSettings;
      expect(yield* settings.concurrency).toEqual({ configured: Option.none(), effective: 3 });
      expect((yield* settings.setConcurrency(8)).effective).toBe(8);
      expect(yield* Effect.flip(settings.setConcurrency(0))).toEqual(
        KanbanSettingsRefused.make({ reason: "concurrency_out_of_range" }),
      );
      expect(yield* settings.concurrency).toEqual({ configured: Option.some(8), effective: 8 });
      expect((yield* settings.resetConcurrency).configured).toEqual(Option.none());
    }),
  ),
);
