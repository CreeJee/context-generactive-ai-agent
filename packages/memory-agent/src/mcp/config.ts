import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Either, ParseResult, Schema } from "effect";

/** Where MCP servers are configured: user-wide in the storage root, or in a project. */
export const McpScope = Schema.Literal("global", "project");
export type McpScope = typeof McpScope.Type;

export const globalMcpFile = (storageRoot: string) => join(storageRoot, "mcp.json");
/** The same file name Claude Code and other agents read, so a project's servers are shared. */
export const projectMcpFile = (projectRoot: string) => join(projectRoot, ".mcp.json");

/** A server the app starts itself and talks to over stdin/stdout. */
const StdioServer = Schema.TaggedStruct("stdio", {
  command: Schema.NonEmptyString,
  args: Schema.Array(Schema.String),
  env: Schema.Record({ key: Schema.String, value: Schema.String }),
});

/** A server already running somewhere, reached over Streamable HTTP. */
const HttpServer = Schema.TaggedStruct("http", {
  url: Schema.NonEmptyString,
  headers: Schema.Record({ key: Schema.String, value: Schema.String }),
});

export const McpServerConfig = Schema.Union(StdioServer, HttpServer);
export type McpServerConfig = typeof McpServerConfig.Type;

const StringMap = Schema.Record({ key: Schema.String, value: Schema.String });

/** `.mcp.json` entries: `{ command, args?, env? }` (type absent or "stdio") or `{ type: "http", url, headers? }`. */
const FileEntry = Schema.Union(
  Schema.transform(
    Schema.Struct({
      type: Schema.optional(Schema.Literal("stdio")),
      command: Schema.NonEmptyString,
      args: Schema.optional(Schema.Array(Schema.String)),
      env: Schema.optional(StringMap),
    }),
    StdioServer,
    {
      strict: true,
      decode: (entry) => ({
        _tag: "stdio" as const,
        command: entry.command,
        args: entry.args ?? [],
        env: entry.env ?? {},
      }),
      encode: (server) => ({ command: server.command, args: server.args, env: server.env }),
    },
  ),
  Schema.transform(
    Schema.Struct({
      type: Schema.Literal("http"),
      url: Schema.NonEmptyString,
      headers: Schema.optional(StringMap),
    }),
    HttpServer,
    {
      strict: true,
      decode: (entry) => ({ _tag: "http" as const, url: entry.url, headers: entry.headers ?? {} }),
      encode: (server) => ({ type: "http" as const, url: server.url, headers: server.headers }),
    },
  ),
);

/** Server names become part of tool names, so they are kept short and plain. */
export const McpServerName = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{1,32}$/));
const isServerName = Schema.is(McpServerName);

const McpFile = Schema.Struct({
  mcpServers: Schema.Record({ key: Schema.String, value: FileEntry }),
});
const decodeMcpFile = Schema.decodeUnknownEither(Schema.parseJson(McpFile));

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
  readonly error: string | null;
}

export const fingerprintOf = (config: McpServerConfig) =>
  createHash("sha256")
    .update(JSON.stringify(Schema.encodeSync(McpServerConfig)(config)))
    .digest("hex");

export function readMcpFile(path: string, scope: McpScope): McpFileRead {
  if (!existsSync(path)) return { path, servers: [], error: null };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { path, servers: [], error: "unreadable" };
  }
  return Either.match(decodeMcpFile(text), {
    onLeft: (error) => ({
      path,
      servers: [],
      error: ParseResult.TreeFormatter.formatErrorSync(error).split("\n").slice(0, 4).join("\n"),
    }),
    onRight: (file) => {
      const entries = Object.entries(file.mcpServers);
      const invalid = entries.filter(([name]) => !isServerName(name)).map(([name]) => name);
      return {
        path,
        // The valid servers stay usable; the others are named so the user can rename them.
        error:
          invalid.length > 0
            ? `server names must be 1-32 letters, digits, _ or -: ${invalid.join(", ")}`
            : null,
        servers: entries
          .filter(([name]) => isServerName(name))
          .map(([name, config]) => ({ scope, name, config, fingerprint: fingerprintOf(config) })),
      };
    },
  });
}

export class MissingVariable extends Error {
  readonly variable: string;

  constructor(variable: string) {
    super(`missing_env: ${variable}`);
    this.variable = variable;
  }
}

/** Replaces `${NAME}` with the app's environment, so secrets can stay out of the file. */
export function expandVariables(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const found = env[name];
    if (found === undefined) throw new MissingVariable(name);
    return found;
  });
}
