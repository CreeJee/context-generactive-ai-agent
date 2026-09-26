import { createHash, randomUUID } from "node:crypto";
import { Option, Schema } from "effect";

export interface PasswordEntry {
  // Native Windows keyring returns null for an absent entry, despite its undefined-only typings.
  getPassword(): Promise<string | null | undefined>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

// Windows CRED_MAX_CREDENTIAL_BLOB_SIZE is 2,560 bytes; keyring encodes passwords as UTF-16.
const passwordLimit = 1_280;
const manifestPrefix = "context-agent:chunked-password:v1:";
const Manifest = Schema.Struct({
  generation: Schema.String.check(Schema.isUUID(4)),
  count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 256 })),
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
type Manifest = typeof Manifest.Type;
const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest));
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function manifest(value: string | null | undefined): Manifest | null {
  if (value == null || !value.startsWith(manifestPrefix)) return null;
  return Option.getOrThrowWith(
    decodeManifest(value.slice(manifestPrefix.length)),
    () => new Error("Invalid credential manifest."),
  );
}

/** Keep every fragment in the OS vault, and publish a new generation only after all writes succeed. */
export function createChunkedPasswordEntry(
  open: (account: string) => PasswordEntry,
  account: string,
): PasswordEntry {
  const root = open(account);
  const chunk = (value: Manifest, index: number) => open(`${account}:${value.generation}:${index}`);
  const removeChunks = async (value: Manifest) => {
    // Serialize native vault mutations, but still try every fragment if one deletion fails.
    const results: PromiseSettledResult<boolean>[] = [];
    for (let index = 0; index < value.count; index++)
      results.push(...(await Promise.allSettled([chunk(value, index).deleteCredential()])));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  };

  return {
    async getPassword() {
      let encoded = (await root.getPassword()) ?? undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const current = manifest(encoded);
        if (current === null) return encoded;
        const parts = await Promise.all(
          Array.from(
            { length: current.count },
            async (_, index) => (await chunk(current, index).getPassword()) ?? undefined,
          ),
        );
        const password = Buffer.from(parts.join(""), "base64").toString("utf8");
        if (parts.every((part) => part !== undefined) && digest(password) === current.digest)
          return password;
        // A concurrent refresh or logout may have retired the generation we just read.
        const latest = (await root.getPassword()) ?? undefined;
        if (latest === encoded) throw new Error("Incomplete credential fragments.");
        encoded = latest;
      }
      throw new Error("Credential changed while reading.");
    },

    async setPassword(password) {
      const previous = manifest(await root.getPassword());
      if (password.length <= passwordLimit) {
        await root.setPassword(password);
      } else {
        // ASCII fragments also avoid splitting a surrogate pair at a native string boundary.
        const encoded = Buffer.from(password).toString("base64");
        const next: Manifest = {
          generation: randomUUID(),
          count: Math.ceil(encoded.length / passwordLimit),
          digest: digest(password),
        };
        if (next.count > 256) throw new Error("Credential exceeds the fragment limit.");
        try {
          for (let index = 0; index < next.count; index++)
            await chunk(next, index).setPassword(
              encoded.slice(index * passwordLimit, (index + 1) * passwordLimit),
            );
          await root.setPassword(manifestPrefix + JSON.stringify(next));
        } catch (error) {
          await removeChunks(next).catch(() => {});
          throw error;
        }
      }
      // The new refresh token is already committed; cleanup failure must not invalidate it.
      if (previous !== null) await removeChunks(previous).catch(() => {});
    },

    async deleteCredential() {
      const previous = manifest(await root.getPassword());
      const deleted = await root.deleteCredential();
      if (previous !== null) await removeChunks(previous);
      return deleted;
    },
  };
}
