import { Effect } from "effect";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createHash } from "node:crypto";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { existsSync, readFileSync } from "node:fs";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
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
  createHash("sha256")
    .update(
      JSON.stringify([
        command.command,
        command.args,
        Object.entries(command.env).sort(([a], [b]) => a.localeCompare(b)),
      ]),
    )
    .digest("hex");

// Fixed-arity application/SDK contract; these arguments are not a data-last collection API.
// @effect-diagnostics-next-line missingPipeableSignature:off
export function readAgentsFile(path: string, scope: AgentScope): AgentsFileRead {
  if (!existsSync(path)) return { path, agents: [], error: null };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { path, agents: [], error: "unreadable" };
  }
  return Result.match(decodeAgentsFile(text), {
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
}
