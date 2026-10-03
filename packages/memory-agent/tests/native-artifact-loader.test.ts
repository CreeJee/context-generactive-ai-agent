import { createHash } from "node:crypto";
import { mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect } from "effect";
import { build } from "vite";
import { expect, test } from "vite-plus/test";
import {
  loadTrustedNativeArtifact,
  nativeFactoryLoaderContract,
} from "../src/agent/native-artifact-loader.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const descriptor = (file: string, bytes: string) => ({
  fileUrl: pathToFileURL(file).href,
  sha256: digest(bytes),
  contractVersion: nativeFactoryLoaderContract,
});

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await realpath(await mkdtemp(join(root, ".loader-test-")));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Negative fixtures intentionally cross the loader's schema boundary.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
const rejection = (input: unknown, directory: string, explicitlyTrusted = true) =>
  Effect.runPromise(
    Effect.scoped(
      loadTrustedNativeArtifact(input, {
        explicitlyTrusted,
        ownerControlledDirectory: directory,
      }).pipe(Effect.flip),
    ),
  );

test("invalid trust/hash/contract/path never evaluates marker bytes", async () => {
  await fixture(async (directory) => {
    const marker = join(directory, "marker");
    const bytes = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'evaluated');`;
    const file = join(directory, "artifact.mjs");
    await writeFile(file, bytes);
    const saved = descriptor(file, bytes);
    expect((await rejection(saved, directory, false)).reason).toBe("trust");
    expect((await rejection({ ...saved, sha256: "0".repeat(64) }, directory)).reason).toBe(
      "integrity",
    );
    expect((await rejection({ ...saved, contractVersion: "v2" }, directory)).reason).toBe(
      "descriptor",
    );
    expect((await rejection({ ...saved, fileUrl: saved.fileUrl + "?v=1" }, directory)).reason).toBe(
      "path",
    );
    const link = join(directory, "link.mjs");
    await symlink(file, link);
    expect((await rejection(descriptor(link, bytes), directory)).reason).toBe("path");
    expect((await rejection(descriptor(directory, bytes), directory)).reason).toBe("path");
    expect(await readdir(directory)).not.toContain("marker");
    expect((await rejection(saved, directory)).reason).toBe("exports");
    expect(await readdir(directory)).toContain("marker");
    expect((await readdir(directory)).some((name) => name.startsWith(".verified-native-"))).toBe(
      false,
    );
    await writeFile(file, "throw new Error('bad artifact');");
    expect(
      (await rejection(descriptor(file, "throw new Error('bad artifact');"), directory)).reason,
    ).toBe("evaluation");
  });
});

test("real bundled A/B/A subscription factories execute verified snapshots with scoped staging", async () => {
  await fixture(async (directory) => {
    const result = await build({
      configFile: false,
      root,
      logLevel: "silent",
      build: {
        write: false,
        minify: false,
        lib: { entry: join(root, "src/agent/native-artifact-entry.ts"), formats: ["es"] },
        rollupOptions: {
          external: (id) => !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("\0"),
        },
      },
    });
    const outputs = Array.isArray(result) ? result : [result];
    expect(outputs).toHaveLength(1);
    // SAFETY: finite non-watch build returns output; single output checked above.
    const output = outputs[0] as Extract<Awaited<ReturnType<typeof build>>, { output: unknown }>;
    const chunks = output.output.filter((item) => item.type === "chunk");
    expect(chunks).toHaveLength(1);
    const code = chunks[0]!.code;
    const a = join(directory, "a.mjs");
    const b = join(directory, "b.mjs");
    await writeFile(a, code);
    await writeFile(b, code + "\n// generation B\n");
    const urls: string[] = [];
    for (const saved of [
      descriptor(a, code),
      descriptor(b, code + "\n// generation B\n"),
      descriptor(a, code),
    ]) {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const loaded = yield* loadTrustedNativeArtifact(saved, {
              explicitlyTrusted: true,
              ownerControlledDirectory: directory,
            });
            urls.push(loaded.stagedUrl);
            // Replacing the source after acquisition cannot replace the verified evaluated snapshot.
            yield* Effect.promise(() =>
              writeFile(fileURLToPath(saved.fileUrl), "throw new Error('source replaced');"),
            );
            const implementation =
              loaded.factories.createSubscriptionRuntimeImplementation("openai");
            let clients = 0;
            const bound = implementation.bind({
              client: () => {
                clients++;
                return {
                  stream: async function* () {
                    yield { type: "text" as const, text: "unused" };
                  },
                };
              },
            });
            expect(bound.runMiddleware().name).toContain("subscription-run");
            expect(clients).toBe(0);
          }),
        ),
      );
      await writeFile(a, code);
      await writeFile(b, code + "\n// generation B\n");
      expect((await readdir(directory)).some((name) => name.startsWith(".verified-native-"))).toBe(
        false,
      );
    }
    expect(new Set(urls).size).toBe(3);
  });
}, 60_000);
