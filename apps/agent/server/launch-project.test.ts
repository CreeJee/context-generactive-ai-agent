import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { isThisApp, launchFolder, openProject } from "./launch-project";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "context-agent-launch-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("launch folder", () => {
  test("is the folder given, or the folder started from unless that is no real working folder", () => {
    const base = tempDir();
    const project = join(base, "project");
    const storage = join(base, "storage");
    mkdirSync(join(project, "src"), { recursive: true });
    mkdirSync(join(storage, "runtime"), { recursive: true });
    writeFileSync(join(project, "README.md"), "");

    expect(launchFolder(undefined, project, storage)).toEqual({ kind: "folder", root: project });
    expect(launchFolder("src", project, storage)).toEqual({
      kind: "folder",
      root: join(project, "src"),
    });
    // A double-click starts in "/", a plain terminal in the home folder: neither is a project.
    expect(launchFolder(undefined, "/", storage)).toEqual({ kind: "none" });
    expect(launchFolder(undefined, homedir(), storage)).toEqual({ kind: "none" });
    expect(launchFolder(undefined, join(storage, "runtime"), storage)).toEqual({ kind: "none" });
    // A folder named on the command line must exist and be a folder.
    expect(launchFolder("missing", project, storage)).toEqual({
      kind: "invalid",
      path: join(project, "missing"),
    });
    expect(launchFolder("README.md", project, storage).kind).toBe("invalid");
  });
});

describe("opening the folder on the app", () => {
  test("adds it, or finds it when it is registered already, and reports refusals", async () => {
    const projects = [{ id: "p-1", root: "/work/known" }];
    const server = createServer((request, response) => {
      const reply = (status: number, json: string) =>
        response.writeHead(status, { "content-type": "application/json" }).end(json);
      const rejected = (reason: string) =>
        reply(422, JSON.stringify({ error: "project_rejected", reason }));
      if (request.method === "GET") return reply(200, JSON.stringify(projects));
      let text = "";
      request.on("data", (chunk: Buffer) => (text += chunk.toString()));
      request.on("end", () => {
        const root = String(JSON.parse(text).root);
        if (root === "/work/known") return rejected("already_registered");
        if (root.startsWith("/storage")) return rejected("overlaps_storage");
        reply(201, JSON.stringify({ id: "p-2", root }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    // SAFETY: a server listening on a TCP port reports an AddressInfo, never a pipe name.
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    expect(await isThisApp(baseUrl)).toBe(true);
    expect(await isThisApp("http://127.0.0.1:1")).toBe(false);
    expect(await openProject(baseUrl, "/work/new")).toEqual({
      kind: "opened",
      projectId: "p-2",
      added: true,
    });
    expect(await openProject(baseUrl, "/work/known")).toEqual({
      kind: "opened",
      projectId: "p-1",
      added: false,
    });
    expect(await openProject(baseUrl, "/storage/inside")).toEqual({
      kind: "rejected",
      reason: "overlaps_storage",
    });
  });
});
