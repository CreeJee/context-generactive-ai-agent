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
      const initial = yield* Effect.tryPromise(() => developmentBuildId(app));
      yield* fs.writeFileString(path.join(uiSource, "chat-panel.tsx"), "export const ui = 2;");
      const uiBuildId = yield* Effect.tryPromise(() => developmentBuildId(app));
      expect(uiBuildId).toBe(initial);
      // A UI-only HMR update must not block an otherwise valid mutation.
      expect(
        developmentRequestDecision(
          createDevelopmentBoundary({ buildId: initial }),
          "POST",
          "/api/projects",
          uiBuildId,
        ),
      ).toEqual({ kind: "allow" });
      yield* fs.writeFileString(path.join(backendSource, "index.ts"), "export const runtime = 2;");
      const changedBackendId = yield* Effect.tryPromise(() => developmentBuildId(app));
      expect(changedBackendId).not.toBe(initial);
      // Editing disk sources does not change the running backend's identity.
      expect(
        developmentRequestDecision(
          createDevelopmentBoundary({ buildId: initial }),
          "POST",
          "/api/chat",
          initial,
        ),
      ).toEqual({ kind: "allow" });
      // An unvalidated UI/backend contract must not silently mutate the old backend.
      expect(
        developmentRequestDecision(
          createDevelopmentBoundary({ buildId: initial }),
          "POST",
          "/api/projects",
          changedBackendId,
        ),
      ).toMatchObject({ kind: "reject", status: 409 });
    }),
  );

  test("reports its build and rejects stale or draining mutations", () => {
    const boundary = createDevelopmentBoundary({ buildId: "build-a" });
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
      const release = yield* Effect.tryPromise(() =>
        acquireStorageLock(storage, 5180, "instance-a"),
      );
      yield* Effect.addFinalizer(() => Effect.promise(release));
      yield* Effect.tryPromise(() =>
        expect(acquireStorageLock(storage, 5181, "instance-b")).rejects.toThrow(
          "backend already owns this storage root on port 5180",
        ),
      );
      yield* Effect.promise(release);
      const releaseAgain = yield* Effect.tryPromise(() =>
        acquireStorageLock(storage, 5181, "instance-b"),
      );
      yield* Effect.promise(releaseAgain);
    }),
  );
});
