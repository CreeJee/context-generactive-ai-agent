import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, mkdirSync, realpathSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { Context, Data, Effect, Layer, Schema } from "effect";
import {
  JSONRPCClient,
  createJSONRPCErrorResponse,
  type JSONRPCRequest,
  type JSONRPCResponse,
} from "json-rpc-2.0";
import { StorageRoot } from "../config/storage-root.ts";

export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json };

export class CodexUnavailable extends Data.TaggedError("CodexUnavailable")<{
  readonly reason: "not_installed" | "spawn_failed" | "exited";
}> {}

export class CodexRequestFailed extends Data.TaggedError("CodexRequestFailed")<{
  readonly method: string;
  /** JSON-RPC error code when codex answered with an error; absent for timeouts and bad replies. */
  readonly code?: number;
  readonly message: string;
}> {}

export interface CodexInfo {
  readonly executable: string;
  readonly version: string | null;
  /** Whether this app was checked against this codex version. Other versions still run. */
  readonly tested: boolean;
}

/** How to start the app server. Tests point this at a fake server script. */
export interface CodexCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

export const testedCodexVersions: readonly string[] = ["0.154.0"];

/**
 * Codex runs only as the model backend. Its own shell, MCP, web search, skills and history are
 * off; tools come from this app. Keys follow codex-cli 0.154.0.
 *
 * `code_mode_host` stays on (its default): code_mode_only models such as gpt-5.6 call this app's
 * tools from inside codex's V8 code-mode sandbox, and without the host they see no tools at all.
 */
const nativeConfig = [
  'cli_auth_credentials_store = "keyring"',
  'forced_login_method = "chatgpt"',
  'model_provider = "openai"',
  'approval_policy = "never"',
  'sandbox_mode = "read-only"',
  'web_search = "disabled"',
  "project_doc_max_bytes = 0",
  "mcp_servers = {}",
  'history.persistence = "none"',
  "analytics.enabled = false",
  'shell_environment_policy.inherit = "none"',
  // Keeps skills installed on this machine out of the model context; still marked under development.
  "features.skip_host_skill_discovery = true",
  "suppress_unstable_features_warning = true",
  ...[
    "shell_tool",
    "unified_exec",
    "shell_snapshot",
    "apps",
    "plugins",
    "hooks",
    "browser_use",
    "browser_use_external",
    "computer_use",
    "image_generation",
    "view_image",
    "multi_agent",
    "memories",
    "skill_search",
    "tool_suggest",
    "workspace_dependencies",
    "unbounded_connection_retries",
  ].map((feature) => `features.${feature} = false`),
];

/** Finds `codex` on absolute PATH entries only, so a project directory can never shadow it. */
export function findCodex(searchPath = process.env.PATH ?? ""): string | null {
  for (const directory of searchPath.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try {
      const executable = realpathSync(join(directory, "codex"));
      if (!statSync(executable).isFile()) continue;
      accessSync(executable, constants.X_OK);
      return executable;
    } catch {
      continue;
    }
  }
  return null;
}

const maxFrameBytes = 16 * 1024 * 1024;
const requestTimeoutMs = 30_000;

const Frame = Schema.Struct({
  id: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  method: Schema.optional(Schema.String),
});
const decodeFrame = Schema.decodeUnknownSync(Schema.parseJson(Frame));

interface Connection {
  readonly child: ChildProcessWithoutNullStreams;
  readonly client: JSONRPCClient;
  readonly exited: Promise<void>;
  closed: boolean;
}

const make = (command: CodexCommand | null) =>
  Effect.gen(function* () {
    const storage = yield* StorageRoot;
    const codexHome = join(storage.path, "codex");
    const notificationListeners = new Map<string, Set<(params: Json) => void>>();
    const requestHandlers = new Map<string, (params: Json) => Promise<Json>>();
    let connection: Connection | null = null;
    let starting: Promise<Connection> | null = null;

    const resolved =
      command ??
      (() => {
        const executable = findCodex();
        return executable
          ? {
              executable,
              args: [
                "app-server",
                "--listen",
                "stdio://",
                ...nativeConfig.flatMap((line) => ["-c", line]),
              ],
            }
          : null;
      })();

    function version(executable: string) {
      const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 10_000 });
      return /(\d+\.\d+\.\d+)/.exec(result.stdout ?? "")?.[1] ?? null;
    }

    function dispatch(conn: Connection, line: string) {
      const frame = decodeFrame(line);
      // Codex omits the "jsonrpc" field; the library expects it.
      const message = { ...JSON.parse(line), jsonrpc: "2.0" };
      if (frame.method === undefined) {
        conn.client.receive(message);
      } else if (frame.id === undefined) {
        for (const listener of notificationListeners.get(frame.method) ?? [])
          listener(message.params ?? null);
      } else {
        const handler = requestHandlers.get(frame.method);
        const id = frame.id;
        const reply = (response: JSONRPCResponse) => send(conn, response);
        if (!handler) {
          reply(createJSONRPCErrorResponse(id, -32601, "Not supported by this client"));
          return;
        }
        handler(message.params ?? null).then(
          (result) => reply({ jsonrpc: "2.0", id, result }),
          (error) =>
            reply(
              createJSONRPCErrorResponse(
                id,
                -32000,
                error instanceof Error ? error.message : "failed",
              ),
            ),
        );
      }
    }

    function send(conn: Connection, frame: JSONRPCRequest | JSONRPCResponse) {
      if (conn.closed) throw new Error("codex app-server is not running");
      conn.child.stdin.write(`${JSON.stringify(frame)}\n`);
    }

    function start(spec: CodexCommand): Promise<Connection> {
      mkdirSync(codexHome, { recursive: true, mode: 0o700 });
      const child = spawn(spec.executable, [...spec.args], {
        cwd: codexHome,
        stdio: "pipe",
        env: {
          // macOS Keychain resolves through the real account HOME; CODEX_HOME keeps config separate.
          HOME: process.platform === "darwin" ? userInfo().homedir : codexHome,
          CODEX_HOME: codexHome,
          PATH: "/usr/bin:/bin",
          LANG: "en_US.UTF-8",
        },
      });
      const conn: Connection = {
        child,
        client: new JSONRPCClient((request) => send(conn, request)),
        exited: new Promise((resolve) => child.once("close", () => resolve())),
        closed: false,
      };
      const shutdown = () => {
        if (conn.closed) return;
        conn.closed = true;
        conn.client.rejectAllPendingRequests("codex app-server exited");
        if (connection === conn) connection = null;
      };
      child.once("close", shutdown);
      child.once("error", shutdown);
      child.stderr.resume(); // never surfaced: it can contain account details

      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > maxFrameBytes) {
          child.kill("SIGTERM");
          return;
        }
        for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim() === "") continue;
          try {
            dispatch(conn, line);
          } catch {
            child.kill("SIGTERM"); // malformed protocol: do not guess
          }
        }
      });

      const initialized = conn.client.timeout(requestTimeoutMs).request("initialize", {
        clientInfo: {
          name: "context_generactive_agent",
          title: "Context Generactive Agent",
          version: "0.0.0",
        },
        capabilities: { experimentalApi: true },
      });
      return Promise.resolve(initialized).then(() => {
        conn.client.notify("initialized", undefined, undefined);
        return conn;
      });
    }

    /** Starts codex on first use and again after it exits. A failed request is never retried here. */
    const connect = Effect.suspend(() => {
      if (!resolved) return Effect.fail(new CodexUnavailable({ reason: "not_installed" }));
      if (connection) return Effect.succeed(connection);
      starting ??= start(resolved).then(
        (conn) => {
          connection = conn;
          starting = null;
          return conn;
        },
        (error) => {
          starting = null;
          throw error;
        },
      );
      const pending = starting;
      return Effect.tryPromise({
        try: () => pending,
        catch: () => new CodexUnavailable({ reason: "spawn_failed" }),
      });
    });

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        const conn = connection;
        if (!conn) return;
        conn.child.stdin.end();
        conn.child.kill("SIGTERM");
        const force = setTimeout(() => conn.child.kill("SIGKILL"), 1_000);
        await conn.exited;
        clearTimeout(force);
      }),
    );

    return {
      info: Effect.sync((): CodexInfo | null => {
        if (!resolved) return null;
        const detected = command ? null : version(resolved.executable);
        return {
          executable: resolved.executable,
          version: detected,
          tested: detected !== null && testedCodexVersions.includes(detected),
        };
      }),

      request: <A, I>(method: string, params: Json | undefined, schema: Schema.Schema<A, I>) =>
        Effect.gen(function* () {
          const conn = yield* connect;
          const result = yield* Effect.tryPromise({
            try: () => conn.client.timeout(requestTimeoutMs).request(method, params),
            catch: (error) =>
              conn.closed
                ? new CodexUnavailable({ reason: "exited" })
                : new CodexRequestFailed({
                    method,
                    message: error instanceof Error ? error.message : "request failed",
                  }),
          });
          return yield* Schema.decodeUnknown(schema)(result).pipe(
            Effect.mapError(
              () => new CodexRequestFailed({ method, message: "unexpected response" }),
            ),
          );
        }),

      notify: (method: string, params?: Json) =>
        Effect.map(connect, (conn) => conn.client.notify(method, params, undefined)),

      onNotification(method: string, listener: (params: Json) => void) {
        const listeners = notificationListeners.get(method) ?? new Set();
        listeners.add(listener);
        notificationListeners.set(method, listeners);
        return () => listeners.delete(listener);
      },

      /** Answers codex-initiated requests such as dynamic tool calls. Unregistered methods are refused. */
      onRequest(method: string, handler: (params: Json) => Promise<Json>) {
        requestHandlers.set(method, handler);
        return () => requestHandlers.delete(method);
      },
    };
  });

/** One long-lived `codex app-server` over stdio, using a CODEX_HOME owned by this app. */
export class CodexAppServer extends Context.Tag("memory-agent/CodexAppServer")<
  CodexAppServer,
  Effect.Effect.Success<ReturnType<typeof make>>
>() {
  /** Uses `codex` from PATH. */
  static readonly layer = Layer.scoped(CodexAppServer, make(null));
  static readonly withCommand = (command: CodexCommand) =>
    Layer.scoped(CodexAppServer, make(command));
}
