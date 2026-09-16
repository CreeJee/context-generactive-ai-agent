// Runs the built executable from a folder outside the repository (so nothing resolves from the
// repo's node_modules) against a throwaway storage root, and checks what a user's first start
// needs. Run with `vp run smoke-package` after `vp run package`. Downloads codex (~116 MB) once.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";

const app = fileURLToPath(new URL("..", import.meta.url));
const windows = process.platform === "win32";
const executableName = windows ? "context-agent.exe" : "context-agent";
const built = join(
  app,
  "dist",
  `context-agent-${process.platform}-${process.arch}`,
  executableName,
);
if (!existsSync(built)) throw new Error("no executable; run `vp run package` first");

const base = realpathSync(mkdtempSync(join(tmpdir(), "context-agent-smoke-")));
const executable = join(base, "bin", executableName);
const storage = join(base, "storage");
const project = join(base, "project");
mkdirSync(join(base, "bin"));
mkdirSync(project);
cpSync(built, executable);

const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // SAFETY: a server listening on a TCP port reports an AddressInfo, never a pipe name.
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function until<T>(what: string, probe: () => Promise<T | null>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe().catch(() => null);
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function start(port: number) {
  const child = spawn(executable, ["--port", String(port), "--no-open", "--storage", storage], {
    cwd: base,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  return child;
}

async function stop(child: ChildProcess) {
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  // Windows cannot deliver SIGTERM to another console process; end the whole tree there.
  if (windows && child.pid !== undefined)
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
  return exited;
}

const Auth = Schema.Struct({ status: Schema.String });
const Created = Schema.Struct({ id: Schema.String });
const Text = Schema.Struct({ text: Schema.String });
/** Assembled at run time so no key-shaped text sits in the repository. */
const smokeToken = `${"gh"}p_${"S1m2O3k4E5t6O7k8E9n0A1b2C3d4E5f6G7h8"}`;
const Catalog = Schema.Struct({
  skills: Schema.Array(Schema.Struct({ name: Schema.String, scope: Schema.String })),
});
const json = <A, I>(schema: Schema.Schema<A, I>, response: Response) =>
  response.json().then((body) => Schema.decodeUnknownSync(schema)(body));

const runtimeFolders = () =>
  existsSync(join(storage, "runtime"))
    ? readdirSync(join(storage, "runtime")).filter((name) => /^[0-9a-f]{16}$/.test(name))
    : [];
/** Processes started from the storage root's runtime folder (codex and its code-mode host). */
const codexProcesses = () =>
  windows
    ? spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${join(storage, "runtime")}\\*' }).ProcessId`,
        ],
        { encoding: "utf8" },
      ).stdout.trim()
    : spawnSync("pgrep", ["-f", join(storage, "runtime")], { encoding: "utf8" }).stdout.trim();

/** A request with a Host header fetch() does not allow setting. */
const statusWithHost = (url: string, host: string) =>
  new Promise<number>((resolve, reject) => {
    const request = httpRequest(url, { headers: { host } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.end();
  });

try {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const post = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  let started = Date.now();
  let server = start(port);
  await until(
    "the server",
    () => fetch(url).then((response) => (response.ok ? response : null)),
    60_000,
  );
  check("first start serves the app", true, `${Date.now() - started} ms`);
  const [folder] = runtimeFolders();
  check(
    "runtime unpacked once into the storage root",
    runtimeFolders().length === 1 &&
      folder !== undefined &&
      existsSync(join(storage, "runtime", folder, ".complete")),
    folder ?? "none",
  );

  const page = await fetch(url).then((response) => response.text());
  const asset = /\/assets\/[^"]+\.js/.exec(page)?.[0];
  const assetResponse = asset ? await fetch(`${url}${asset}`) : null;
  check(
    "client assets with immutable caching",
    assetResponse?.status === 200 &&
      (assetResponse.headers.get("cache-control") ?? "").includes("immutable"),
  );

  const badHost = await statusWithHost(`${url}/api/auth`, "evil.example");
  check("non-loopback Host refused", badHost === 403, String(badHost));
  const crossSite = await post(
    "/api/auth",
    { intent: "logout" },
    { Origin: "https://evil.example" },
  );
  check("cross-site POST refused", crossSite.status === 403, String(crossSite.status));

  started = Date.now();
  const firstAuth = await json(Auth, await fetch(`${url}/api/auth`));
  check(
    "sign-in reports codex installing on first need",
    firstAuth.status === "installing",
    firstAuth.status,
  );
  const auth = await until(
    "codex install",
    async () => {
      const state = await json(Auth, await fetch(`${url}/api/auth`));
      return state.status === "installing" ? null : state;
    },
    300_000,
  );
  check(
    "codex downloaded, verified and started",
    auth.status === "signed-out" || auth.status === "signed-in",
    `${auth.status} after ${Math.round((Date.now() - started) / 1000)} s`,
  );

  const created = await post("/api/projects", { root: project });
  check("project added (SQLite, vector index)", created.status === 201, String(created.status));
  const projectId = created.status === 201 ? (await json(Created, created)).id : "";
  const session = await post("/api/sessions", { projectId });
  check("session created", session.status === 201, String(session.status));
  const kagi = await fetch(`${url}/api/settings/kagi`);
  check("keychain addon loads (Kagi status)", kagi.status === 200, String(kagi.status));
  // Built-in skills are found next to the unpacked runtime, a path only the executable takes.
  const catalog = await json(Catalog, await fetch(`${url}/api/projects/${projectId}/skills`));
  const builtin = catalog.skills.filter((skill) => skill.scope === "builtin");
  check(
    "built-in skills unpacked and listed",
    builtin.some((skill) => skill.name === "draw"),
    builtin.map((skill) => skill.name).join(", ") || "none",
  );

  const acp = spawnSync(executable, ["acp", "--port", String(port)], {
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } })}\n`,
    encoding: "utf8",
    timeout: 30_000,
  });
  check(
    "acp answers initialize on stdout",
    acp.stdout.includes('"agentInfo"'),
    acp.stdout.slice(0, 80),
  );

  check("codex child running before stop", codexProcesses() !== "");
  const code = await stop(server);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  if (windows) check("stopping the tree ends codex too", codexProcesses() === "");
  else
    check(
      "SIGTERM stops the server and its codex",
      code === 0 && codexProcesses() === "",
      `exit ${code}`,
    );

  const unpackedAt = folder ? statSync(join(storage, "runtime", folder, ".complete")).mtimeMs : 0;

  // A node stored the way it was before secrets were hidden on the way in; the start below sweeps
  // it. This is the only check that runs the bundled secret detector.
  const sessionId = session.status === 201 ? (await json(Created, session)).id : "";
  const seeded = (() => {
    const database = new DatabaseSync(join(storage, "agent.db"));
    try {
      database
        .prepare(
          "INSERT INTO nodes (id, project_id, session_id, kind, text, created_at) VALUES ('smoke-secret', ?, ?, 'tool_result', ?, ?)",
        )
        .run(projectId, sessionId, `GITHUB_TOKEN=${smokeToken}`, new Date().toISOString());
      return true;
    } finally {
      database.close();
    }
  })();

  started = Date.now();
  server = start(port);
  await until(
    "the second start",
    () => fetch(url).then((response) => (response.ok ? response : null)),
    60_000,
  );
  check(
    "second start reuses the unpacked runtime",
    folder !== undefined &&
      statSync(join(storage, "runtime", folder, ".complete")).mtimeMs === unpackedAt,
    `${Date.now() - started} ms`,
  );
  // The agent (and the sweep it starts) is made on the first API request, as the page makes one.
  await fetch(`${url}/api/auth`);
  const swept = await until(
    "the secret sweep",
    async () => {
      const database = new DatabaseSync(join(storage, "agent.db"), { readOnly: true });
      try {
        const row = database.prepare("SELECT text FROM nodes WHERE id = 'smoke-secret'").get();
        const text = row ? Schema.decodeUnknownSync(Text)(row).text : "";
        return text.includes(smokeToken) ? null : text;
      } finally {
        database.close();
      }
    },
    30_000,
  );
  check(
    "stored secrets swept on start (bundled detector)",
    seeded && swept === "GITHUB_TOKEN=[redacted:github]",
    swept,
  );
  await stop(server);
} finally {
  rmSync(base, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
