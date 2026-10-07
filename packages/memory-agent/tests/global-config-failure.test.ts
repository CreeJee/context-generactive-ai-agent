import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { assertInstanceOf, strictEqual } from "@effect/vitest/utils";
import { Context, Effect, FileSystem, Layer } from "effect";
import { GlobalConfig, GlobalConfigFailed } from "../src/config/global-config.ts";
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
    strictEqual(failure.reason._tag, "InvalidSettings");
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
    strictEqual(failure.reason._tag, "ReadFailed");
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
    strictEqual(failure.reason._tag, "WriteFailed");
  }),
);
