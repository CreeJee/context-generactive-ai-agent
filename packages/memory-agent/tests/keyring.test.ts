import { it } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";
import { describe, expect } from "vite-plus/test";
import { keyringEntry, SecretBackend, SecretFileStoreFailed } from "../src/runtime/keyring.ts";
import { withTestPlatform } from "./support/platform.ts";

const key = (fill: number) => Option.some(Buffer.alloc(32, fill).toString("base64"));
const secretDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "memory-agent-keyring-" });
  const entry = (account: string, encodedKey: Option.Option<string>) =>
    keyringEntry(
      "service",
      account,
      SecretBackend.file({ directory, key: encodedKey, keyFile: Option.none() }),
    );
  return { directory, entry };
});

describe("encrypted secret directory", () => {
  it.live("stores, reads and deletes an entry without writing the plaintext", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { directory, entry } = yield* secretDirectory;
      const account = yield* entry("account", key(1));
      expect(yield* account.getPassword).toBeNull();
      yield* account.setPassword("plain-secret");
      expect(yield* account.getPassword).toBe("plain-secret");
      const [file = ""] = yield* fs.readDirectory(directory);
      expect(yield* fs.readFileString(`${directory}/${file}`)).not.toContain("plain-secret");
      expect(yield* account.deletePassword).toBe(true);
      expect(yield* account.getPassword).toBeNull();
    }).pipe(withTestPlatform),
  );

  it.live("refuses a different key and an entry file moved to another account", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { directory, entry } = yield* secretDirectory;
      yield* (yield* entry("a", key(1))).setPassword("secret-a");
      const [fileA = ""] = yield* fs.readDirectory(directory);
      yield* (yield* entry("b", key(1))).setPassword("secret-b");
      const fileB = (yield* fs.readDirectory(directory)).find((name) => name !== fileA) ?? "";
      yield* fs.copyFile(`${directory}/${fileA}`, `${directory}/${fileB}`);
      const decrypt = SecretFileStoreFailed.make({ reason: "decrypt" });
      expect(yield* Effect.flip((yield* entry("b", key(1))).getPassword)).toEqual(decrypt);
      expect(yield* Effect.flip((yield* entry("a", key(2))).getPassword)).toEqual(decrypt);
    }).pipe(withTestPlatform),
  );

  it.live("fails without a key instead of using the OS keychain", () =>
    Effect.gen(function* () {
      const { entry } = yield* secretDirectory;
      expect(
        yield* Effect.flip((yield* entry("account", Option.none())).setPassword("secret")),
      ).toEqual(SecretFileStoreFailed.make({ reason: "key_missing" }));
    }).pipe(withTestPlatform),
  );
});
