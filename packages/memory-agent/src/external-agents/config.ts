import { Function as EffectFunction } from "effect";
import { Effect, FileSystem } from "effect";
import { sha256 as hashSha256 } from "../runtime/synchronous-crypto.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { path as platformPath } from "../runtime/synchronous-path.ts";
const { join } = platformPath;
import { Result, Schema } from "effect";
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
  readonly error: string | null;
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
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))))
    return { path, agents: [], error: null } satisfies AgentsFileRead;
  const text = yield* fs.readFileString(path).pipe(Effect.result);
  if (Result.isFailure(text))
    return { path, agents: [], error: "unreadable" } satisfies AgentsFileRead;
  return Result.match(decodeAgentsFile(text.success), {
    onFailure: (error) => ({
      path,
      agents: [],
      error: String(error).split("\n").slice(0, 4).join("\n"),
    }),
    onSuccess: (file) => {
      const entries = Object.entries(file.agents);
      const invalid = entries.filter(([name]) => !isAgentName(name)).map(([name]) => name);
      return {
        path,
        error:
          invalid.length > 0
            ? `agent names must be 1-32 letters, digits, _ or -: ${invalid.join(", ")}`
            : null,
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
  });
});

export const readAgentsFile: {
  (scope: AgentScope): (path: string) => ReturnType<typeof readAgentsFileBody>;
} & typeof readAgentsFileBody = EffectFunction.dual(2, readAgentsFileBody);
