import { NodeCrypto, NodePath, NodeServices } from "@effect/platform-node";
import { Crypto, Effect, FileSystem, ManagedRuntime, Path } from "effect";
import { Function as EffectFunction } from "effect";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { Hex } from "effect/encoding";

// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.

import { nativeFailure } from "memory-agent/native-effect";
import { DateTime, Option, Schema, Scope, Exit, Cause } from "effect";

const { join, resolve } = ManagedRuntime.make(NodePath.layer).runSync(Path.Path);

export const developmentBuildHeader = "x-context-agent-build-id";

export const developmentBackendWatchPaths = (appRoot: string) => [
  resolve(appRoot, "../../packages/memory-agent/src"),
  resolve(appRoot, "app/routes/api"),
  resolve(appRoot, "app/.server"),
  resolve(appRoot, "app/entry/api.ts"),
  resolve(appRoot, "server"),
  resolve(appRoot, "package.json"),
  resolve(appRoot, "../../packages/memory-agent/package.json"),
];

const fingerprintRuntime = ManagedRuntime.make(NodeServices.layer);
const fingerprintFiles = Effect.fn("dev.fingerprintFiles")(function* (
  path: string,
): Effect.fn.Return<string[], never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const { basename, join } = yield* Path.Path;
  const info = yield* fs.stat(path).pipe(Effect.option);
  if (Option.isNone(info)) return [];
  switch (info.value.type) {
    case "File":
      return basename(path).includes(".test.") ? [] : [path];
    case "Directory": {
      const entries = yield* fs.readDirectory(path).pipe(Effect.orDie);
      const results: string[] = [];
      for (const entry of entries) {
        const child = join(path, entry);
        if (Option.isSome(yield* fs.readLink(child).pipe(Effect.option))) continue;
        results.push(...(yield* fingerprintFiles(child)));
      }
      return results;
    }
    default:
      return [];
  }
});

const fingerprint = Effect.fn("dev.fingerprint")(function* (appRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const files: string[] = [];
  for (const watched of developmentBackendWatchPaths(appRoot))
    files.push(...(yield* fingerprintFiles(watched)));
  files.sort();
  const encoder = new TextEncoder();
  const delimiter = encoder.encode("\\0");
  const chunks: Uint8Array[] = [];
  for (const file of files) {
    chunks.push(
      encoder.encode(path.relative(appRoot, file)),
      delimiter,
      yield* fs.readFile(file),
      delimiter,
    );
  }
  const input = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    input.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Hex.encode(yield* crypto.digest("SHA-256", input)).slice(0, 24);
});

/** Stable fingerprint of every source file owned by the no-HMR backend boundary. */
export const developmentBuildId = (appRoot: string) =>
  fingerprintRuntime.runPromise(fingerprint(appRoot));

export const affectsDevelopmentBackend = (file: string) => {
  const path = file.replaceAll("\\\\", "/");
  return (
    path.includes("/packages/memory-agent/") ||
    path.includes("/apps/agent/app/routes/api/") ||
    path.includes("/apps/agent/app/.server/") ||
    path.endsWith("/apps/agent/app/entry/api.ts") ||
    path.includes("/apps/agent/server/")
  );
};

const LockRecord = Schema.Struct({
  pid: Schema.Finite,
  instanceId: Schema.String,
  port: Schema.Finite,
});
const decodeLock = Schema.decodeUnknownOption(Schema.fromJsonString(LockRecord));

export interface DevelopmentBoundary {
  readonly buildId: string;
  readonly instanceId: string;
  readonly startedAt: string;
  readonly draining: () => boolean;
  readonly beginDrain: () => void;
}

export function createDevelopmentBoundary({
  buildId,
  instanceId = ManagedRuntime.make(NodeCrypto.layer).runSync(
    Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomUUIDv4()),
  ),
}: {
  readonly buildId: string;
  readonly instanceId?: string;
}): DevelopmentBoundary {
  let isDraining = false;
  return {
    buildId,
    instanceId,
    startedAt: DateTime.formatIso(DateTime.nowUnsafe()),
    draining: () => isDraining,
    beginDrain: () => {
      isDraining = true;
    },
  };
}

export type DevelopmentRequestDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "health"; readonly status: 200; readonly body: string }
  | {
      readonly kind: "reject";
      readonly status: 409 | 503;
      readonly error: "backend_restart_required" | "backend_restarting";
      readonly backendBuildId: string;
      readonly presentedBuildId: string | null;
      readonly body: string;
    };

export const developmentRequestDecision: {
  (
    method: string | undefined,
    pathname: string,
    presentedBuildId: string | undefined,
  ): (boundary: DevelopmentBoundary) => ReturnType<typeof developmentRequestDecisionBody>;
} & typeof developmentRequestDecisionBody = EffectFunction.dual(4, developmentRequestDecisionBody);
function developmentRequestDecisionBody(
  boundary: DevelopmentBoundary,
  method: string | undefined,
  pathname: string,
  presentedBuildId: string | undefined,
): DevelopmentRequestDecision {
  if (pathname === "/api/health") {
    return {
      kind: "health",
      status: 200,
      body: JSON.stringify({
        buildId: boundary.buildId,
        runtimeInstanceId: boundary.instanceId,
        startedAt: boundary.startedAt,
        status: boundary.draining() ? "draining" : "ready",
      }),
    };
  }
  // OAuth callbacks use a separate loopback listener, not an app /api route.
  const mutates = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  if (!pathname.startsWith("/api/") || !mutates) return { kind: "allow" };
  if (boundary.draining()) {
    const error = "backend_restarting" as const;
    return {
      kind: "reject",
      status: 503,
      error,
      backendBuildId: boundary.buildId,
      presentedBuildId: presentedBuildId ?? null,
      body: JSON.stringify({ error }),
    };
  }
  if (presentedBuildId !== boundary.buildId) {
    const error = "backend_restart_required" as const;
    return {
      kind: "reject",
      status: 409,
      error,
      backendBuildId: boundary.buildId,
      presentedBuildId: presentedBuildId ?? null,
      body: JSON.stringify({ error }),
    };
  }
  return { kind: "allow" };
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const NativeError = Schema.Struct({ code: Schema.String });
    return Schema.is(NativeError)(error) && error.code === "EPERM";
  }
}

/** Acquires one backend owner for a storage root. The returned release is idempotent. */
export const acquireStorageLock: {
  (
    port: number,
    instanceId: string,
  ): (storageRoot: string) => ReturnType<typeof acquireStorageLockBody>;
} & typeof acquireStorageLockBody = EffectFunction.dual(3, acquireStorageLockBody);
function acquireStorageLockBody(storageRoot: string, port: number, instanceId: string) {
  return fingerprintRuntime
    .runPromiseExit(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const file = join(storageRoot, "backend.lock");
        const record = { pid: process.pid, instanceId, port };
        yield* fs.makeDirectory(storageRoot, { recursive: true, mode: 0o700 });
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(LockRecord))(record);
        const create = fs.writeFileString(file, encoded, {
          flag: "wx",
          mode: 0o600,
        });
        yield* create.pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              if (error.reason._tag !== "AlreadyExists") return yield* error;
              const existing = Option.getOrNull(decodeLock(yield* fs.readFileString(file)));
              if (existing !== null && processIsAlive(existing.pid))
                return yield* new Cause.UnknownError(
                  new Error(`backend already owns this storage root on port ${existing.port}`),
                );
              yield* fs.remove(file);
              yield* create;
            }),
          ),
        );
        const scope = yield* Scope.make();
        yield* Scope.addFinalizer(
          scope,
          Effect.gen(function* () {
            const existing = Option.getOrNull(decodeLock(yield* fs.readFileString(file)));
            if (existing?.instanceId === instanceId) yield* fs.remove(file);
          }).pipe(Effect.ignore),
        );
        return () => fingerprintRuntime.runPromise(Scope.close(scope, Exit.void));
      }),
    )
    .then(
      Exit.match({
        onSuccess: (release) => release,
        onFailure: (cause) => Promise.reject(nativeFailure(cause).cause),
      }),
    );
}
