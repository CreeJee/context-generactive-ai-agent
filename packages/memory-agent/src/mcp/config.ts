import { Function as EffectFunction } from "effect";
import { SchemaTransformation } from "effect";
import { sha256 as hashSha256 } from "../runtime/synchronous-crypto.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { path as platformPath } from "../runtime/synchronous-path.ts";
const { join } = platformPath;
import { Effect, FileSystem, Result, Schema } from "effect";
import type { ConfigFileFailureCode, ShownFailure } from "../runtime/shown-failure.ts";

/** Where MCP servers are configured: user-wide in the storage root, or in a project. */
export const McpScope = Schema.Literals(["global", "project"]);
export type McpScope = typeof McpScope.Type;

export const globalMcpFile = (storageRoot: string) => join(storageRoot, "mcp.json");
/** The same file name Claude Code and other agents read, so a project's servers are shared. */
export const projectMcpFile = (projectRoot: string) => join(projectRoot, ".mcp.json");

/** A server the app starts itself and talks to over stdin/stdout. */
const StdioServer = Schema.TaggedStruct("stdio", {
  command: Schema.NonEmptyString,
  args: Schema.Array(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
});

/** A server already running somewhere, reached over Streamable HTTP. */
const HttpServer = Schema.TaggedStruct("http", {
  url: Schema.NonEmptyString,
  headers: Schema.Record(Schema.String, Schema.String),
});

export const McpServerConfig = Schema.Union([StdioServer, HttpServer]);
export type McpServerConfig = typeof McpServerConfig.Type;

const StringMap = Schema.Record(Schema.String, Schema.String);

/** `.mcp.json` entries: `{ command, args?, env? }` (type absent or "stdio") or `{ type: "http", url, headers? }`. */
const FileEntry = Schema.Union([
  Schema.Struct({
    type: Schema.optional(Schema.Literal("stdio")),
    command: Schema.NonEmptyString,
    args: Schema.optional(Schema.Array(Schema.String)),
    env: Schema.optional(StringMap),
  }).pipe(
    Schema.decodeTo(
      StdioServer,
      SchemaTransformation.transform({
        decode: (entry) => ({
          _tag: "stdio" as const,
          command: entry.command,
          args: entry.args ?? [],
          env: entry.env ?? {},
        }),
        encode: (server) => ({ command: server.command, args: server.args, env: server.env }),
      }),
    ),
  ),
  Schema.Struct({
    type: Schema.Literal("http"),
    url: Schema.NonEmptyString,
    headers: Schema.optional(StringMap),
  }).pipe(
    Schema.decodeTo(
      HttpServer,
      SchemaTransformation.transform({
        decode: (entry) => ({
          _tag: "http" as const,
          url: entry.url,
          headers: entry.headers ?? {},
        }),
        encode: (server) => ({ type: "http" as const, url: server.url, headers: server.headers }),
      }),
    ),
  ),
]);

/** Server names become part of tool names, so they are kept short and plain. */
export const McpServerName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,32}$/)),
);
const isServerName = Schema.is(McpServerName);

const McpFile = Schema.Struct({
  mcpServers: Schema.Record(Schema.String, FileEntry),
});
const decodeMcpFile = Schema.decodeUnknownResult(Schema.fromJsonString(McpFile));

export interface ConfiguredServer {
  readonly scope: McpScope;
  readonly name: string;
  readonly config: McpServerConfig;
  /** Hash of the exact configuration. Trust is given to this, not to the name. */
  readonly fingerprint: string;
}

export interface McpFileRead {
  readonly path: string;
  readonly servers: readonly ConfiguredServer[];
  /** Why the file could not be used. A missing file is not an error. */
  /** Not redacted: the owner hides secrets in `detail` before showing it. */
  readonly error: ShownFailure<ConfigFileFailureCode> | null;
}

export const fingerprintOf = (config: McpServerConfig) =>
  hashSha256(
    JSON.stringify(
      EffectFunction.flow(Schema.encodeResult(McpServerConfig), Result.getOrThrow)(config),
    ),
  );

const readMcpFileBody = Effect.fn("mcp.readConfig")(function* (path: string, scope: McpScope) {
  const fs = yield* FileSystem.FileSystem;
  // A file whose presence cannot be checked is treated as absent, like a missing one.
  if (!(yield* fs.exists(path).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(false)))))
    return { path, servers: [], error: null } satisfies McpFileRead;
  const text = yield* fs.readFileString(path).pipe(Effect.result);
  if (Result.isFailure(text))
    return { path, servers: [], error: { code: "unreadable", detail: null } } satisfies McpFileRead;
  return Result.match(decodeMcpFile(text.success), {
    onFailure: (error) => ({
      path,
      servers: [],
      error: {
        code: "invalid_config" as const,
        detail: String(error).split("\n").slice(0, 4).join("\n"),
      },
    }),
    onSuccess: (file) => {
      const entries = Object.entries(file.mcpServers);
      const invalid = entries.filter(([name]) => !isServerName(name)).map(([name]) => name);
      return {
        path,
        // The valid servers stay usable; the others are named so the user can rename them.
        error:
          invalid.length > 0
            ? { code: "invalid_names" as const, detail: invalid.join(", ") }
            : null,
        servers: entries
          .filter(([name]) => isServerName(name))
          .map(([name, config]) => ({ scope, name, config, fingerprint: fingerprintOf(config) })),
      };
    },
  });
});

export const readMcpFile: {
  (scope: McpScope): (path: string) => ReturnType<typeof readMcpFileBody>;
} & typeof readMcpFileBody = EffectFunction.dual(2, readMcpFileBody);

/** A `${NAME}` the configuration uses is not set; the message names the variable, not a value. */
export class MissingVariable extends Schema.TaggedError<MissingVariable>()("MissingVariable", {
  variable: Schema.String,
}) {
  override get message() {
    return `missing_env: ${this.variable}`;
  }
}

const variablePattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Replaces `${NAME}` with the app's environment, so secrets can stay out of the file. */
export const expandVariablesResult = (
  value: string,
  env: NodeJS.ProcessEnv,
): Result.Result<string, MissingVariable> => {
  for (const [, name] of value.matchAll(variablePattern))
    if (name !== undefined && env[name] === undefined)
      return Result.fail(new MissingVariable({ variable: name }));
  return Result.succeed(value.replace(variablePattern, (_, name: string) => env[name] ?? ""));
};

/** `expandVariablesResult` for synchronous SDK transport builders, which throw the typed error. */
export const expandVariables: {
  (env: NodeJS.ProcessEnv): (value: string) => ReturnType<typeof expandVariablesBody>;
} & typeof expandVariablesBody = EffectFunction.dual(2, expandVariablesBody);
function expandVariablesBody(value: string, env: NodeJS.ProcessEnv): string {
  return Result.getOrThrow(expandVariablesResult(value, env));
}
