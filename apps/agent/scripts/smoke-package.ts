// Runs the built executable from a folder outside the repository (so nothing resolves from the
// repo's node_modules) against a throwaway storage root, and checks what a user's first start
// needs. Run with `vp run smoke-package` after `vp run package`.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
  const env = { ...process.env };
  delete env.CONTEXT_AGENT_BUILD_ID;
  delete env.CONTEXT_AGENT_DEV_BACKEND;
  const child = spawn(executable, ["--port", String(port), "--no-open", "--storage", storage], {
    cwd: base,
    env,
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

const ErrorResponse = Schema.Struct({ error: Schema.String });
const Created = Schema.Struct({ id: Schema.String });
const Text = Schema.Struct({ text: Schema.String });
/** Assembled at run time so no key-shaped text sits in the repository. */
const smokeToken = `${"gh"}p_${"S1m2O3k4E5t6O7k8E9n0A1b2C3d4E5f6G7h8"}`;
const Catalog = Schema.Struct({
  skills: Schema.Array(Schema.Struct({ name: Schema.String, scope: Schema.String })),
});
const json = <A, I>(schema: Schema.Codec<A, I>, response: Response) =>
  response.json().then((body) => Schema.decodeUnknownSync(schema)(body));

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

let server: ChildProcess | null = null;
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
  server = start(port);
  await until(
    "the server",
    () => fetch(url).then((response) => (response.ok ? response : null)),
    60_000,
  );
  check("first start serves the app", true, `${Date.now() - started} ms`);

  const page = await fetch(url).then((response) => response.text());
  const asset = /\/assets\/[^"]+\.js/.exec(page)?.[0];
  const assetResponse = asset ? await fetch(`${url}${asset}`) : null;
  check(
    "client assets with immutable caching",
    assetResponse?.status === 200 &&
      (assetResponse.headers.get("cache-control") ?? "").includes("immutable"),
  );

  const badHost = await statusWithHost(`${url}/api/auth?provider=openai`, "evil.example");
  check("non-loopback Host refused", badHost === 403, String(badHost));
  const crossSite = await post(
    "/api/auth",
    { intent: "logout", provider: "openai" },
    { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
  );
  check("cross-site POST refused", crossSite.status === 403, String(crossSite.status));

  const authResponse = await fetch(`${url}/api/auth?provider=invalid`);
  const authError = await json(ErrorResponse, authResponse);
  check(
    "provider auth route validates the provider",
    authResponse.status === 400 && authError.error === "invalid_provider",
    `${authResponse.status} ${authError.error}`,
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

  const code = await stop(server);
  check("server shuts down cleanly", windows || code === 0, `exit ${code}`);

  // A node stored the way it was before secrets were hidden on the way in; the start below sweeps
  // it. This check exercises the packaged secret detector.
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

  server = start(port);
  await until(
    "the second start",
    () => fetch(url).then((response) => (response.ok ? response : null)),
    60_000,
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
  if (server !== null && server.exitCode === null) await stop(server);
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
