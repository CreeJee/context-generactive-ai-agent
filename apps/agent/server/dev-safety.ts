import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { Option, Schema } from "effect";

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

const fingerprintFiles = (path: string): string[] => {
  if (!existsSync(path)) return [];
  const entries = readdirSync(path, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return fingerprintFiles(child);
    if (!entry.isFile() || entry.name.includes(".test.")) return [];
    return [child];
  });
};

/** Stable fingerprint of every source file owned by the no-HMR backend boundary. */
export function developmentBuildId(appRoot: string) {
  const hash = createHash("sha256");
  const files = developmentBackendWatchPaths(appRoot)
    .flatMap((path) => (existsSync(path) && !readdirSafe(path) ? [path] : fingerprintFiles(path)))
    .sort();
  for (const file of files) {
    hash.update(relative(appRoot, file));
    hash.update("\\0");
    hash.update(readFileSync(file));
    hash.update("\\0");
  }
  return hash.digest("hex").slice(0, 24);
}

const readdirSafe = (path: string) => {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
};

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
  pid: Schema.Number,
  instanceId: Schema.String,
  port: Schema.Number,
});
const decodeLock = Schema.decodeUnknownOption(Schema.fromJsonString(LockRecord));

export interface DevelopmentBoundary {
  readonly buildId: string;
  readonly instanceId: string;
  readonly startedAt: string;
  readonly draining: () => boolean;
  readonly beginDrain: () => void;
}

export function createDevelopmentBoundary(
  buildId: string,
  instanceId: string = randomUUID(),
): DevelopmentBoundary {
  let isDraining = false;
  return {
    buildId,
    instanceId,
    startedAt: new Date().toISOString(),
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

export function developmentRequestDecision(
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
  const oauthCallback = pathname.startsWith("/api/auth/") && pathname.endsWith("/callback");
  const mutates = oauthCallback || (method !== "GET" && method !== "HEAD" && method !== "OPTIONS");
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
export function acquireStorageLock(storageRoot: string, port: number, instanceId: string) {
  mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  const file = join(storageRoot, "backend.lock");
  const record = { pid: process.pid, instanceId, port };

  const create = () => {
    const descriptor = openSync(file, "wx", 0o600);
    try {
      writeFileSync(descriptor, JSON.stringify(record));
    } finally {
      closeSync(descriptor);
    }
  };

  try {
    create();
  } catch (error) {
    const FsError = Schema.Struct({ code: Schema.String });
    if (!Schema.is(FsError)(error) || error.code !== "EEXIST") throw error;
    const existing = Option.getOrNull(decodeLock(readFileSync(file, "utf8")));
    if (existing !== null && processIsAlive(existing.pid)) {
      throw new Error(`backend already owns this storage root on port ${existing.port}`);
    }
    unlinkSync(file);
    create();
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const existing = Option.getOrNull(decodeLock(readFileSync(file, "utf8")));
      if (existing?.instanceId === instanceId) unlinkSync(file);
    } catch {
      // The lock is already absent or no longer ours.
    }
  };
}
