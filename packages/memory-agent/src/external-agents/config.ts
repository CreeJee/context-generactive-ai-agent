import { Function as EffectFunction } from "effect";
import { Effect, FileSystem } from "effect";
import { sha256 as hashSha256 } from "../runtime/synchronous-crypto.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { path as platformPath } from "../runtime/synchronous-path.ts";
const { join } = platformPath;
import { Result, Schema } from "effect";
import type { ConfigFileFailureCode, ShownFailure } from "../runtime/shown-failure.ts";
import { McpServerName } from "../mcp/config.ts";

export const AgentScope = Schema.Literals(["global", "project"]);
export type AgentScope = typeof AgentScope.Type;

export const globalAgentsFile = (storageRoot: string) => join(storageRoot, "agents.json");
export const projectAgentsFile = (projectRoot: string) =>
  join(projectRoot, ".agents", "agents.json");

/** An ACP agent the app starts and talks to over stdin/stdout, like Zed's `agent_servers`. */
export const AgentCommand = Schema.Struct({
  command: Schema.NonEmptyString,
  args: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultTypeKey(Effect.sync(() => []))),
  env: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.sync(() => ({}))),
  ),
});
export type AgentCommand = typeof AgentCommand.Type;

const AgentsFile = Schema.Struct({
  agents: Schema.Record(Schema.String, AgentCommand),
});
const decodeAgentsFile = Schema.decodeUnknownResult(Schema.fromJsonString(AgentsFile));
const isAgentName = Schema.is(McpServerName);

export interface ConfiguredAgent {
  readonly scope: AgentScope;
  readonly name: string;
  readonly command: AgentCommand;
  /** Hash of the exact command, arguments and environment the user trusts. */
  readonly fingerprint: string;
}

export interface AgentsFileRead {
  readonly path: string;
  readonly agents: readonly ConfiguredAgent[];
  /** Not redacted: the owner hides secrets in `detail` before showing it. */
  readonly error: ShownFailure<ConfigFileFailureCode> | null;
}

export const agentFingerprint = (command: AgentCommand) =>
  hashSha256(
    JSON.stringify([
      command.command,
      command.args,
      Object.entries(command.env).sort(([a], [b]) => a.localeCompare(b)),
    ]),
  );

const readAgentsFileBody = Effect.fn("agents.readConfig")(function* (
  path: string,
  scope: AgentScope,
): Effect.fn.Return<AgentsFileRead, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const read = fs.readFileString(path).pipe(
    Effect.map((text) =>
      Result.match(decodeAgentsFile(text), {
        onFailure: (error): AgentsFileRead => ({
          path,
          agents: [],
          error: {
            code: "invalid_config",
            detail: String(error).split("\n").slice(0, 4).join("\n"),
          },
        }),
        onSuccess: (file): AgentsFileRead => {
          const entries = Object.entries(file.agents);
          const invalid = entries.filter(([name]) => !isAgentName(name)).map(([name]) => name);
          return {
            path,
            error:
              invalid.length > 0 ? { code: "invalid_names", detail: invalid.join(", ") } : null,
            agents: entries
              .filter(([name]) => isAgentName(name))
              .map(([name, command]) => ({
                scope,
                name,
                command,
                fingerprint: agentFingerprint(command),
              })),
          };
        },
      }),
    ),
    Effect.orElseSucceed((): AgentsFileRead => ({
      path,
      agents: [],
      error: { code: "unreadable", detail: null },
    })),
  );
  // A file whose presence cannot be checked is treated as absent, like a missing one.
  return yield* fs.exists(path).pipe(
    Effect.catchTag("PlatformError", () => Effect.succeed(false)),
    Effect.flatMap((exists) =>
      exists ? read : Effect.succeed<AgentsFileRead>({ path, agents: [], error: null }),
    ),
  );
});

export const readAgentsFile: {
  (scope: AgentScope): (path: string) => ReturnType<typeof readAgentsFileBody>;
} & typeof readAgentsFileBody = EffectFunction.dual(2, readAgentsFileBody);
