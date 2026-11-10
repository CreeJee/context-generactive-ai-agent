import { Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
import { acpCopy } from "./copy.ts";
import { path } from "../runtime/synchronous-path.ts";
import type { ToolKind } from "@agentclientprotocol/sdk";
import { HashMap, Option, Schema } from "effect";

/** How an editor should show one of the agent's tools: a title and an ACP tool kind. */
export interface ToolView {
  readonly title: string;
  readonly kind: ToolKind;
}

const views = HashMap.fromIterable<string, ToolView>([
  ["find_memory", { title: acpCopy.toolTitle.find_memory, kind: "search" }],
  ["read_evidence", { title: acpCopy.toolTitle.read_evidence, kind: "read" }],
  ["trace_evidence", { title: acpCopy.toolTitle.trace_evidence, kind: "search" }],
  ["list_files", { title: acpCopy.toolTitle.list_files, kind: "search" }],
  ["search_files", { title: acpCopy.toolTitle.search_files, kind: "search" }],
  ["read_file", { title: acpCopy.toolTitle.read_file, kind: "read" }],
  ["write_file", { title: acpCopy.toolTitle.write_file, kind: "edit" }],
  ["edit_file", { title: acpCopy.toolTitle.edit_file, kind: "edit" }],
  ["delete_file", { title: acpCopy.toolTitle.delete_file, kind: "delete" }],
  ["list_outside_files", { title: acpCopy.toolTitle.list_outside_files, kind: "search" }],
  ["read_outside_file", { title: acpCopy.toolTitle.read_outside_file, kind: "read" }],
  ["search_outside_file", { title: acpCopy.toolTitle.search_outside_file, kind: "search" }],
  // Calls recorded before shell skills replaced it.
  ["run_shell", { title: acpCopy.toolTitle.run_shell, kind: "execute" }],
  // Calls recorded before code skills replaced it.
  ["save_shell_skill", { title: acpCopy.toolTitle.save_shell_skill, kind: "edit" }],
  ["save_code_skill", { title: acpCopy.toolTitle.save_code_skill, kind: "edit" }],
  ["run_skill", { title: acpCopy.toolTitle.run_skill, kind: "execute" }],
  ["run_code", { title: acpCopy.toolTitle.run_code, kind: "execute" }],
  ["write_outside_file", { title: acpCopy.toolTitle.write_outside_file, kind: "edit" }],
  ["delete_outside_file", { title: acpCopy.toolTitle.delete_outside_file, kind: "delete" }],
  ["kagi_search", { title: acpCopy.toolTitle.kagi_search, kind: "fetch" }],
  ["kagi_extract", { title: acpCopy.toolTitle.kagi_extract, kind: "fetch" }],
  ["read_skill", { title: acpCopy.toolTitle.read_skill, kind: "read" }],
  ["run_subagent", { title: acpCopy.toolTitle.run_subagent, kind: "other" }],
  // Calls recorded before run_subagent took a helper name.
  ["message_subagent", { title: acpCopy.toolTitle.message_subagent, kind: "other" }],
  ["delegate_to_agent", { title: acpCopy.toolTitle.delegate_to_agent, kind: "other" }],
]);

export function toolView(name: string): ToolView {
  return Option.getOrElse(HashMap.get(views, name), (): ToolView => {
    const mcp = /^mcp_([A-Za-z0-9_-]+?)__(.+)$/.exec(name);
    return { title: isTruthy(mcp) ? `MCP ${mcp[1]} · ${mcp[2]}` : name, kind: "other" };
  });
}

const PathArguments = Schema.fromJsonString(
  Schema.Struct({
    path: Schema.optional(Schema.String),
    command: Schema.optional(Schema.String),
    query: Schema.optional(Schema.String),
    task: Schema.optional(Schema.String),
  }),
);
const decodePathArguments = Schema.decodeUnknownOption(PathArguments);

/** A short detail for the title: the path, command, query or task the call is about. */
export function toolDetail(argumentsJson: string): string | null {
  return Option.match(decodePathArguments(argumentsJson), {
    onNone: () => null,
    onSome: (args) => {
      const detail = args.path ?? args.command ?? args.query ?? args.task ?? null;
      return detail === null ? null : detail.length > 80 ? `${detail.slice(0, 77)}…` : detail;
    },
  });
}

/** Absolute paths a call touches, for editors that follow along. Project-relative ones are resolved. */
export const toolLocations: {
  (projectRoot: string): (argumentsJson: string) => ReturnType<typeof toolLocationsBody>;
} & typeof toolLocationsBody = EffectFunction.dual(2, toolLocationsBody);
function toolLocationsBody(argumentsJson: string, projectRoot: string) {
  return Option.match(decodePathArguments(argumentsJson), {
    onNone: () => [],
    // path.resolve() keeps an absolute path (`/x`, `C:\x`) and joins a relative one to the project,
    // normalizing separators and `..` for this platform.
    onSome: (args) =>
      args.path === undefined ? [] : [{ path: path.resolve(projectRoot, args.path) }],
  });
}
