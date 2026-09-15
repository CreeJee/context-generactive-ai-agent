import type { ToolKind } from "@agentclientprotocol/sdk";
import { Option, Schema } from "effect";

/** How an editor should show one of the agent's tools: a title and an ACP tool kind. */
export interface ToolView {
  readonly title: string;
  readonly kind: ToolKind;
}

const views = new Map<string, ToolView>([
  ["find_memory", { title: "기억 검색", kind: "search" }],
  ["read_evidence", { title: "원문 읽기", kind: "read" }],
  ["trace_evidence", { title: "근거 추적", kind: "search" }],
  ["list_files", { title: "파일 목록", kind: "search" }],
  ["search_files", { title: "파일 내용 검색", kind: "search" }],
  ["read_file", { title: "파일 읽기", kind: "read" }],
  ["write_file", { title: "파일 쓰기", kind: "edit" }],
  ["edit_file", { title: "파일 편집", kind: "edit" }],
  ["delete_file", { title: "파일 삭제", kind: "delete" }],
  ["list_outside_files", { title: "밖 파일 목록", kind: "search" }],
  ["read_outside_file", { title: "밖 파일 읽기", kind: "read" }],
  ["search_outside_file", { title: "밖 파일 검색", kind: "search" }],
  ["run_shell", { title: "셸 실행", kind: "execute" }],
  ["write_outside_file", { title: "밖 파일 쓰기", kind: "edit" }],
  ["delete_outside_file", { title: "밖 파일 삭제", kind: "delete" }],
  ["kagi_search", { title: "웹 검색", kind: "fetch" }],
  ["kagi_extract", { title: "웹 페이지 읽기", kind: "fetch" }],
  ["read_skill", { title: "skill 읽기", kind: "read" }],
  ["run_subagent", { title: "서브에이전트 실행", kind: "other" }],
  ["message_subagent", { title: "서브에이전트에게 메시지", kind: "other" }],
]);

export function toolView(name: string): ToolView {
  const known = views.get(name);
  if (known) return known;
  const mcp = /^mcp_([A-Za-z0-9_-]+?)__(.+)$/.exec(name);
  return { title: mcp ? `MCP ${mcp[1]} · ${mcp[2]}` : name, kind: "other" };
}

const PathArguments = Schema.parseJson(
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
export function toolLocations(argumentsJson: string, projectRoot: string) {
  return Option.match(decodePathArguments(argumentsJson), {
    onNone: () => [],
    onSome: (args) =>
      args.path === undefined
        ? []
        : [{ path: args.path.startsWith("/") ? args.path : `${projectRoot}/${args.path}` }],
  });
}
