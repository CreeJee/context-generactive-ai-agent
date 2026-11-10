import { Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/runtime-macro";
import { i18n } from "../i18n.ts";
import { path } from "../runtime/synchronous-path.ts";
import type { ToolKind } from "@agentclientprotocol/sdk";
import { HashMap, Option, Schema } from "effect";

/** How an editor should show one of the agent's tools: a title and an ACP tool kind. */
export interface ToolView {
  readonly title: string;
  readonly kind: ToolKind;
}

/** A built-in tool's view before its title is resolved in the active locale. */
interface ToolViewMessage {
  readonly title: MessageDescriptor;
  readonly kind: ToolKind;
}

/** Tool call titles the editor shows, keyed by tool name. */
const titles = {
  find_memory: msg({ message: "기억 검색", comment: "Tool call title in the editor" }),
  read_evidence: msg({ message: "원문 읽기", comment: "Tool call title in the editor" }),
  trace_evidence: msg({ message: "근거 추적", comment: "Tool call title in the editor" }),
  list_files: msg({ message: "파일 목록", comment: "Tool call title in the editor" }),
  search_files: msg({ message: "파일 내용 검색", comment: "Tool call title in the editor" }),
  read_file: msg({ message: "파일 읽기", comment: "Tool call title in the editor" }),
  write_file: msg({ message: "파일 쓰기", comment: "Tool call title in the editor" }),
  edit_file: msg({ message: "파일 편집", comment: "Tool call title in the editor" }),
  delete_file: msg({ message: "파일 삭제", comment: "Tool call title in the editor" }),
  list_outside_files: msg({
    message: "프로젝트 밖 파일 목록",
    comment: "Tool call title in the editor",
  }),
  read_outside_file: msg({
    message: "프로젝트 밖 파일 읽기",
    comment: "Tool call title in the editor",
  }),
  search_outside_file: msg({
    message: "프로젝트 밖 파일 검색",
    comment: "Tool call title in the editor",
  }),
  run_shell: msg({ message: "셸 실행", comment: "Tool call title in the editor" }),
  save_shell_skill: msg({ message: "셸 스킬 저장", comment: "Tool call title in the editor" }),
  save_code_skill: msg({ message: "코드 스킬 저장", comment: "Tool call title in the editor" }),
  run_skill: msg({ message: "코드 스킬 실행", comment: "Tool call title in the editor" }),
  run_code: msg({ message: "코드 실행", comment: "Tool call title in the editor" }),
  write_outside_file: msg({
    message: "프로젝트 밖 파일 쓰기",
    comment: "Tool call title in the editor",
  }),
  delete_outside_file: msg({
    message: "프로젝트 밖 파일 삭제",
    comment: "Tool call title in the editor",
  }),
  kagi_search: msg({ message: "웹 검색", comment: "Tool call title in the editor" }),
  kagi_extract: msg({ message: "웹 페이지 읽기", comment: "Tool call title in the editor" }),
  read_skill: msg({ message: "skill 읽기", comment: "Tool call title in the editor" }),
  run_subagent: msg({ message: "서브에이전트 실행", comment: "Tool call title in the editor" }),
  message_subagent: msg({
    message: "서브에이전트에게 메시지 보내기",
    comment: "Tool call title in the editor",
  }),
  delegate_to_agent: msg({
    message: "외부 에이전트에게 맡기기",
    comment: "Tool call title in the editor",
  }),
} satisfies Readonly<Record<string, MessageDescriptor>>;

const views = HashMap.fromIterable<string, ToolViewMessage>([
  ["find_memory", { title: titles.find_memory, kind: "search" }],
  ["read_evidence", { title: titles.read_evidence, kind: "read" }],
  ["trace_evidence", { title: titles.trace_evidence, kind: "search" }],
  ["list_files", { title: titles.list_files, kind: "search" }],
  ["search_files", { title: titles.search_files, kind: "search" }],
  ["read_file", { title: titles.read_file, kind: "read" }],
  ["write_file", { title: titles.write_file, kind: "edit" }],
  ["edit_file", { title: titles.edit_file, kind: "edit" }],
  ["delete_file", { title: titles.delete_file, kind: "delete" }],
  ["list_outside_files", { title: titles.list_outside_files, kind: "search" }],
  ["read_outside_file", { title: titles.read_outside_file, kind: "read" }],
  ["search_outside_file", { title: titles.search_outside_file, kind: "search" }],
  // Calls recorded before shell skills replaced it.
  ["run_shell", { title: titles.run_shell, kind: "execute" }],
  // Calls recorded before code skills replaced it.
  ["save_shell_skill", { title: titles.save_shell_skill, kind: "edit" }],
  ["save_code_skill", { title: titles.save_code_skill, kind: "edit" }],
  ["run_skill", { title: titles.run_skill, kind: "execute" }],
  ["run_code", { title: titles.run_code, kind: "execute" }],
  ["write_outside_file", { title: titles.write_outside_file, kind: "edit" }],
  ["delete_outside_file", { title: titles.delete_outside_file, kind: "delete" }],
  ["kagi_search", { title: titles.kagi_search, kind: "fetch" }],
  ["kagi_extract", { title: titles.kagi_extract, kind: "fetch" }],
  ["read_skill", { title: titles.read_skill, kind: "read" }],
  ["run_subagent", { title: titles.run_subagent, kind: "other" }],
  // Calls recorded before run_subagent took a helper name.
  ["message_subagent", { title: titles.message_subagent, kind: "other" }],
  ["delegate_to_agent", { title: titles.delegate_to_agent, kind: "other" }],
]);

export function toolView(name: string): ToolView {
  return Option.match(HashMap.get(views, name), {
    onSome: ({ title, kind }): ToolView => ({ title: i18n._(title), kind }),
    onNone: (): ToolView => {
      const mcp = /^mcp_([A-Za-z0-9_-]+?)__(.+)$/.exec(name);
      return { title: isTruthy(mcp) ? `MCP ${mcp[1]} · ${mcp[2]}` : name, kind: "other" };
    },
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
