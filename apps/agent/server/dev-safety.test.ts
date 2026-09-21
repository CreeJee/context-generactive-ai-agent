import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  acquireStorageLock,
  affectsDevelopmentBackend,
  developmentBuildId,
  developmentRequestDecision,
  createDevelopmentBoundary,
} from "./dev-safety.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("stable development backend safety", () => {
  test("invalidates HMR only for code that belongs to the backend boundary", () => {
    expect(affectsDevelopmentBackend("/repo/packages/memory-agent/src/index.ts")).toBe(true);
    expect(affectsDevelopmentBackend("/repo/apps/agent/app/routes/api/chat.tsx")).toBe(true);
    expect(affectsDevelopmentBackend("/repo/apps/agent/app/entry/chat-panel.tsx")).toBe(false);
  });

  test("fingerprints backend sources but ignores UI-only changes", () => {
    const root = mkdtempSync(join(tmpdir(), "context-agent-dev-fingerprint-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const app = join(root, "apps", "agent");
    const backendSource = join(root, "packages", "memory-agent", "src");
    const uiSource = join(app, "app", "entry");
    mkdirSync(join(app, "server"), { recursive: true });
    mkdirSync(backendSource, { recursive: true });
    mkdirSync(uiSource, { recursive: true });
    writeFileSync(join(app, "server", "main.ts"), "export const server = 1;");
    writeFileSync(join(backendSource, "index.ts"), "export const runtime = 1;");

    const initial = developmentBuildId(app);
    writeFileSync(join(uiSource, "chat-panel.tsx"), "export const ui = 2;");
    expect(developmentBuildId(app)).toBe(initial);
    writeFileSync(join(backendSource, "index.ts"), "export const runtime = 2;");
    expect(developmentBuildId(app)).not.toBe(initial);
  });

  test("reports its build and rejects stale or draining mutations", () => {
    const boundary = createDevelopmentBoundary("build-a");
    expect(developmentRequestDecision(boundary, "GET", "/api/health", undefined)).toMatchObject({
      kind: "health",
      status: 200,
    });
    expect(developmentRequestDecision(boundary, "GET", "/api/models", undefined)).toEqual({
      kind: "allow",
    });
    expect(
      developmentRequestDecision(boundary, "GET", "/api/auth/anthropic/callback", "build-b"),
    ).toMatchObject({
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

  test("allows only one live backend owner for a storage root", () => {
    const storage = mkdtempSync(join(tmpdir(), "context-agent-dev-lock-"));
    cleanups.push(() => rmSync(storage, { recursive: true, force: true }));
    const release = acquireStorageLock(storage, 5180, "instance-a");
    cleanups.push(release);
    expect(() => acquireStorageLock(storage, 5181, "instance-b")).toThrow(
      "backend already owns this storage root on port 5180",
    );
    release();
    const releaseAgain = acquireStorageLock(storage, 5181, "instance-b");
    releaseAgain();
  });
});
