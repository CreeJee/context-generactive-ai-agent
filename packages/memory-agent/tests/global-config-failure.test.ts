import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { assertInstanceOf, assertTrue, strictEqual } from "@effect/vitest/utils";
import { Context, Effect, FileSystem, Layer } from "effect";
import { expect } from "vite-plus/test";
import {
  GlobalConfig,
  GlobalConfigFailed,
  GlobalConfigFailedReason,
  GpuCheck,
} from "../src/config/global-config.ts";
import { StorageRoot } from "../src/config/storage-root.ts";

const fixture = Effect.gen(function* () {
  const fs = Context.get(yield* Layer.build(NodeFileSystem.layer), FileSystem.FileSystem);
  const root = yield* fs.makeTempDirectoryScoped();
  const configAt = (path: string) =>
    Layer.build(GlobalConfig.layer.pipe(Layer.provide(StorageRoot.layer(path)))).pipe(
      Effect.map((services) => Context.get(services, GlobalConfig)),
    );
  return { fs, root, configAt };
});

it.effect("returns malformed persisted settings through the typed failure channel", () =>
  Effect.gen(function* () {
    const { fs, root, configAt } = yield* fixture;
    yield* fs.writeFileString(`${root}/config.json`, "{");
    const config = yield* configAt(root);
    const failure = yield* Effect.flip(config.read);
    assertInstanceOf(failure, GlobalConfigFailed);
    strictEqual(failure.operation, "read");
    assertTrue(GlobalConfigFailedReason.guards.InvalidSettings(failure.reason));
  }),
);

it.effect("preserves the read stage when updating an inaccessible settings path", () =>
  Effect.gen(function* () {
    const { fs, root, configAt } = yield* fixture;
    const blocked = `${root}/blocked`;
    yield* fs.writeFileString(blocked, "file");
    const config = yield* configAt(blocked);
    const failure = yield* Effect.flip(config.update({ imageGenerationEnabled: true }));
    assertInstanceOf(failure, GlobalConfigFailed);
    strictEqual(failure.operation, "read");
    assertTrue(GlobalConfigFailedReason.guards.ReadFailed(failure.reason));
  }),
);

it.effect("returns write failures without treating them as settings validation failures", () =>
  Effect.gen(function* () {
    const { fs, root, configAt } = yield* fixture;
    yield* fs.writeFileString(`${root}/config.json`, "{}");
    const config = yield* configAt(root);
    yield* Effect.addFinalizer(() => fs.chmod(root, 0o700).pipe(Effect.orDie));
    yield* fs.chmod(root, 0o500);
    const failure = yield* Effect.flip(config.update({ imageGenerationEnabled: true }));
    assertInstanceOf(failure, GlobalConfigFailed);
    strictEqual(failure.operation, "write");
    assertTrue(GlobalConfigFailedReason.guards.WriteFailed(failure.reason));
  }),
);

it.effect("rewrites a GPU check 0.0.17 stored under status when it is first read", () =>
  Effect.gen(function* () {
    const { fs, root, configAt } = yield* fixture;
    yield* fs.writeFileString(
      `${root}/config.json`,
      '{"gpuCheck":{"status":"unavailable","checkedAt":"2026-09-16T00:00:00.000Z","reason":"no WebGPU device"},"kagiEnabled":true}',
    );
    const config = yield* configAt(root);
    const check = GpuCheck.cases.unavailable.make({
      checkedAt: "2026-09-16T00:00:00.000Z",
      reason: "no WebGPU device",
    });
    expect(yield* config.read).toEqual({ gpuCheck: check, kagiEnabled: true });
    const rewritten = yield* fs.readFileString(`${root}/config.json`);
    expect(rewritten).toContain('"_tag": "unavailable"');
    expect(rewritten).not.toContain('"status"');
    expect(yield* config.read).toEqual({ gpuCheck: check, kagiEnabled: true });
  }),
);
