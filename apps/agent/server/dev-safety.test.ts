import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { describe, expect, test } from "vite-plus/test";
import {
  acquireStorageLock,
  affectsDevelopmentBackend,
  developmentBuildId,
  developmentRequestDecision,
  createDevelopmentBoundary,
} from "./dev-safety.ts";

const fixture = Effect.fn("devSafety.fixture")(function* (prefix: string) {
  const services = yield* Layer.build(Layer.merge(NodeFileSystem.layer, NodePath.layer));
  const fs = yield* Effect.provideContext(FileSystem.FileSystem, services);
  const path = yield* Effect.provideContext(Path.Path, services);
  const root = yield* fs.makeTempDirectoryScoped({ prefix });
  return { fs, path, root };
});

describe("stable development backend safety", () => {
  test("invalidates HMR only for code that belongs to the backend boundary", () => {
    expect(affectsDevelopmentBackend("/repo/packages/memory-agent/src/index.ts")).toBe(true);
    expect(affectsDevelopmentBackend("/repo/apps/agent/app/routes/api/chat.tsx")).toBe(true);
    expect(affectsDevelopmentBackend("/repo/apps/agent/app/entry/chat-panel.tsx")).toBe(false);
  });

  it.live("fingerprints backend sources but ignores UI-only changes", () =>
    Effect.gen(function* () {
      const { root, fs, path } = yield* fixture("context-agent-dev-fingerprint-");
      const app = path.join(root, "apps", "agent");
      const backendSource = path.join(root, "packages", "memory-agent", "src");
      const uiSource = path.join(app, "app", "entry");
      yield* fs.makeDirectory(path.join(app, "server"), { recursive: true });
      yield* fs.makeDirectory(backendSource, { recursive: true });
      yield* fs.makeDirectory(uiSource, { recursive: true });
      yield* fs.writeFileString(path.join(app, "server", "main.ts"), "export const server = 1;");
      yield* fs.writeFileString(path.join(backendSource, "index.ts"), "export const runtime = 1;");
      const initial = developmentBuildId(app);
      yield* fs.writeFileString(path.join(uiSource, "chat-panel.tsx"), "export const ui = 2;");
      const uiBuildId = developmentBuildId(app);
      expect(uiBuildId).toBe(initial);
      // A UI-only HMR update must not block an otherwise valid mutation.
      expect(
        developmentRequestDecision(
          createDevelopmentBoundary(initial),
          "POST",
          "/api/projects",
          uiBuildId,
        ),
      ).toEqual({ kind: "allow" });
      yield* fs.writeFileString(path.join(backendSource, "index.ts"), "export const runtime = 2;");
      const changedBackendId = developmentBuildId(app);
      expect(changedBackendId).not.toBe(initial);
      // Editing disk sources does not change the running backend's identity.
      expect(
        developmentRequestDecision(
          createDevelopmentBoundary(initial),
          "POST",
          "/api/chat",
          initial,
        ),
      ).toEqual({ kind: "allow" });
      // An unvalidated UI/backend contract must not silently mutate the old backend.
      expect(
        developmentRequestDecision(
          createDevelopmentBoundary(initial),
          "POST",
          "/api/projects",
          changedBackendId,
        ),
      ).toMatchObject({ kind: "reject", status: 409 });
    }),
  );

  it.live("Goal worker source changes retain the current global gate and read/replay path", () =>
    Effect.gen(function* () {
      const { root, fs, path } = yield* fixture("context-agent-goal-source-gate-");
      const app = path.join(root, "apps", "agent");
      const source = path.join(root, "packages", "memory-agent", "src", "agent");
      yield* fs.makeDirectory(source, { recursive: true });
      yield* fs.writeFileString(
        path.join(source, "full-loop-worker.ts"),
        "export const worker = 'v1';",
      );
      yield* fs.writeFileString(
        path.join(source, "full-loop-codec.ts"),
        "export const codec = 'v1';",
      );
      const initial = developmentBuildId(app);
      const boundary = createDevelopmentBoundary(initial);
      yield* fs.writeFileString(
        path.join(source, "full-loop-worker.ts"),
        "export const worker = 'v2';",
      );
      const changedWorker = developmentBuildId(app);
      expect(changedWorker).not.toBe(initial);
      yield* fs.writeFileString(
        path.join(source, "full-loop-codec.ts"),
        "export const codec = 'v2';",
      );
      const changedCodec = developmentBuildId(app);
      expect(changedCodec).not.toBe(changedWorker);
      expect(affectsDevelopmentBackend(path.join(source, "full-loop-worker.ts"))).toBe(true);
      expect(affectsDevelopmentBackend(path.join(source, "full-loop-codec.ts"))).toBe(true);
      expect(developmentRequestDecision(boundary, "POST", "/api/chat", changedCodec)).toMatchObject(
        {
          kind: "reject",
          status: 409,
          error: "backend_restart_required",
        },
      );
      // Source-pinned SDK tests do not authorize bypassing the actual dev request gate.
      expect(developmentRequestDecision(boundary, "GET", "/api/chat", changedCodec)).toEqual({
        kind: "allow",
      });
      expect(
        developmentRequestDecision(boundary, "GET", "/api/health", changedCodec),
      ).toMatchObject({
        kind: "health",
        status: 200,
      });
      expect(boundary.draining()).toBe(false);
    }),
  );

  test("reports its build and rejects stale or draining mutations", () => {
    const boundary = createDevelopmentBoundary("build-a");
    expect(developmentRequestDecision(boundary, "GET", "/api/health", undefined)).toMatchObject({
      kind: "health",
      status: 200,
    });
    expect(developmentRequestDecision(boundary, "GET", "/api/models", undefined)).toEqual({
      kind: "allow",
    });
    // OAuth callbacks use a separate loopback listener at /auth/callback or /callback,
    // not the app's /api route. The build-id gate does not protect that listener.
    expect(developmentRequestDecision(boundary, "GET", "/auth/callback", "build-b")).toEqual({
      kind: "allow",
    });
    expect(developmentRequestDecision(boundary, "POST", "/api/auth", "build-b")).toMatchObject({
      kind: "reject",
      status: 409,
      error: "backend_restart_required",
      backendBuildId: "build-a",
      presentedBuildId: "build-b",
    });
    expect(developmentRequestDecision(boundary, "POST", "/api/chat", "build-b")).toMatchObject({
      kind: "reject",
      status: 409,
    });
    expect(developmentRequestDecision(boundary, "POST", "/api/chat", "build-a")).toEqual({
      kind: "allow",
    });
    boundary.beginDrain();
    expect(developmentRequestDecision(boundary, "POST", "/api/chat", "build-a")).toMatchObject({
      kind: "reject",
      status: 503,
      error: "backend_restarting",
      backendBuildId: "build-a",
      presentedBuildId: "build-a",
    });
  });

  it.live("allows only one live backend owner for a storage root", () =>
    Effect.gen(function* () {
      const { root: storage } = yield* fixture("context-agent-dev-lock-");
      const release = acquireStorageLock(storage, 5180, "instance-a");
      yield* Effect.addFinalizer(() => Effect.sync(release));
      expect(() => acquireStorageLock(storage, 5181, "instance-b")).toThrow(
        "backend already owns this storage root on port 5180",
      );
      release();
      const releaseAgain = acquireStorageLock(storage, 5181, "instance-b");
      releaseAgain();
    }),
  );
});
