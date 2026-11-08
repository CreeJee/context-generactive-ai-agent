import { Effect, FileSystem, Path } from "effect";
import { Digest } from "effect/crypto";
import { Function as EffectFunction } from "effect";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { Hex } from "effect/encoding";

// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.

import { nativeFailure } from "memory-agent/native-effect";
import { nodePlatform } from "memory-agent/node-platform";
import { path as hostPath } from "memory-agent/synchronous-path";
import { lockStorageRoot } from "memory-agent/storage-lock";
import { Array as Arr, DateTime, MutableRef, Option, Scope, Exit, Cause } from "effect";

const { resolve } = hostPath;

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
      const results = yield* Effect.forEach(
        entries,
        Effect.fnUntraced(function* (entry) {
          const child = join(path, entry);
          if (Option.isSome(yield* fs.readLink(child).pipe(Effect.option))) return [];
          return yield* fingerprintFiles(child);
        }),
      );
      return results.flat();
    }
    default:
      return [];
  }
});

const fingerprint = Effect.fn("dev.fingerprint")(function* (appRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Digest.Digest;
  const files = (yield* Effect.forEach(
    developmentBackendWatchPaths(appRoot),
    fingerprintFiles,
  )).flat();
  files.sort();
  const encoder = new TextEncoder();
  const delimiter = encoder.encode("\\0");
  const chunks = (yield* Effect.forEach(files, (file) =>
    Effect.map(fs.readFile(file), (content) => [
      encoder.encode(path.relative(appRoot, file)),
      delimiter,
      content,
      delimiter,
    ]),
  )).flat();
  // Each chunk starts where the ones before it end; the last offset is the whole size.
  const offsets = Arr.scan(chunks, 0, (offset, chunk) => offset + chunk.byteLength);
  const input = new Uint8Array(Arr.lastNonEmpty(offsets));
  Arr.zip(chunks, offsets).forEach(([chunk, offset]) => input.set(chunk, offset));
  return Hex.encode(yield* crypto.digest(Digest.sha256, input)).slice(0, 24);
});

/** Stable fingerprint of every source file owned by the no-HMR backend boundary. */
export const developmentBuildId = (appRoot: string) =>
  nodePlatform.runPromise(fingerprint(appRoot));

export interface DevelopmentBoundary {
  readonly buildId: string;
  readonly instanceId: string;
  readonly startedAt: string;
  readonly draining: () => boolean;
  readonly beginDrain: () => void;
}

export function createDevelopmentBoundary({
  buildId,
  instanceId,
}: {
  readonly buildId: string;
  readonly instanceId: string;
}): DevelopmentBoundary {
  const isDraining = MutableRef.make(false);
  return {
    buildId,
    instanceId,
    startedAt: DateTime.formatIso(DateTime.nowUnsafe()),
    draining: () => MutableRef.get(isDraining),
    beginDrain: () => {
      MutableRef.set(isDraining, true);
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

/** Acquires one backend owner for a storage root. The returned release is idempotent. */
export const acquireStorageLock: {
  (
    port: number,
    instanceId: string,
  ): (storageRoot: string) => ReturnType<typeof acquireStorageLockBody>;
} & typeof acquireStorageLockBody = EffectFunction.dual(3, acquireStorageLockBody);
function acquireStorageLockBody(storageRoot: string, port: number, instanceId: string) {
  return nodePlatform
    .runPromiseExit(
      Effect.gen(function* () {
        // The lock itself lives in memory-agent: the writing CLI commands take the same one.
        const scope = yield* Scope.make();
        yield* Scope.provide(lockStorageRoot({ storageRoot, port, instanceId }), scope).pipe(
          // The caller gets the failure it has always seen; the half-open scope is closed first.
          Effect.catch((error) =>
            Effect.andThen(
              Scope.close(scope, Exit.void),
              Effect.fail(
                new Cause.UnknownError(
                  error._tag === "StorageLockHeld"
                    ? new Error(`backend already owns this storage root on port ${error.port}`)
                    : error.cause,
                ),
              ),
            ),
          ),
        );
        return () => nodePlatform.runPromise(Scope.close(scope, Exit.void));
      }),
    )
    .then(
      Exit.match({
        onSuccess: (release) => release,
        onFailure: (cause) => Promise.reject(nativeFailure(cause).cause),
      }),
    );
}
