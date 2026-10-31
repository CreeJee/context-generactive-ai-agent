import { Array as Arr, Cause, Effect, Option, Schema } from "effect";
// The MCP servers the tool-use cases trust, chosen by the first argument: `tracker`, an issue
// tracker, or `code-index`, a code graph whose guide asks to be used before the file tools.
// Answers are fixed and match the cases' project files.
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

type Arguments = Readonly<Record<string, string>>;

interface EvalTool {
  readonly description: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly answer: (args: Arguments) => string;
}

const issues = {
  "ENG-42": {
    title: "로그인이 30초 뒤 타임아웃됨",
    words: ["login", "timeout", "로그인", "타임아웃"],
    status: "In Progress",
    assignee: "박서연",
  },
  "ENG-57": {
    title: "저장 실패 뒤 저장 버튼이 계속 비활성화됨",
    words: ["save", "button", "저장", "버튼"],
    status: "Todo",
    assignee: "김도윤",
  },
  "OPS-3": {
    title: "스테이징 인증서 교체",
    words: ["certificate", "staging", "인증서", "스테이징"],
    status: "Done",
    assignee: "이하준",
  },
} as const;
const IssueId = Schema.Literals(["ENG-42", "ENG-57", "OPS-3"]);
const issueOf = (id: string | undefined) =>
  Option.map(Schema.decodeUnknownOption(IssueId)(id), (known) => ({ id: known, ...issues[known] }));
const line = (issue: { readonly id: string; readonly status: string; readonly title: string }) =>
  `${issue.id} [${issue.status}] ${issue.title}`;
const allIssues = IssueId.literals.map((id) => ({ id, ...issues[id] }));

const tracker = {
  search_issues: {
    description: "Search issues by words in their title. Returns id, status and title of each.",
    parameters: { query: "Words to look for." },
    answer: ({ query = "" }) => {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const found = allIssues.filter((issue) =>
        issue.words.some((word) => words.some((asked) => asked.includes(word))),
      );
      return found.length > 0
        ? found.map(line).join("\n")
        : `No issue matches. Open issues:\n${allIssues.map(line).join("\n")}`;
    },
  },
  get_issue: {
    description: "One issue in full: title, status and assignee.",
    parameters: { id: "Issue id, such as ENG-42." },
    answer: ({ id }) =>
      Option.match(issueOf(id), {
        onNone: () => `No issue ${id ?? ""}.`,
        onSome: (issue) => `${line(issue)}\nAssignee: ${issue.assignee}`,
      }),
  },
  add_comment: {
    description: "Add a comment to an issue.",
    parameters: { id: "Issue id, such as ENG-42.", body: "The comment text." },
    answer: ({ id }) =>
      Option.match(issueOf(id), {
        onNone: () => `No issue ${id ?? ""}.`,
        onSome: (issue) => `Comment added to ${issue.id}.`,
      }),
  },
  update_status: {
    description: "Move an issue to another status: Todo, In Progress or Done.",
    parameters: { id: "Issue id, such as ENG-42.", status: "The new status." },
    answer: ({ id, status = "" }) =>
      Option.match(issueOf(id), {
        onNone: () => `No issue ${id ?? ""}.`,
        onSome: (issue) => `${issue.id} is now ${status}.`,
      }),
  },
  list_projects: {
    description: "The tracker's projects and their id prefixes.",
    parameters: {},
    answer: () => "ENG (engineering), OPS (operations)",
  },
} satisfies Readonly<Record<string, EvalTool>>;

const codeIndex = {
  explore: {
    description:
      "Answer a code question from the project's index: the matching symbols' source with line numbers, and their callers.",
    parameters: { query: "Symbol names or a question about the code." },
    answer: ({ query = "" }) =>
      query.includes("parseConfig")
        ? [
            "parseConfig: src/config/parse.ts:3",
            "  export function parseConfig(text: string): Config",
            "Callers:",
            "  startServer: src/server.ts:4  const config = parseConfig(text);",
            '  main: src/cli.ts:4  return parseConfig(argv[0] ?? "8080");',
          ].join("\n")
        : "No symbol matches. Indexed symbols: parseConfig, startServer, main.",
  },
  index_status: {
    description: "Whether the index is up to date with the files on disk.",
    parameters: {},
    answer: () => "3 files indexed, none pending.",
  },
} satisfies Readonly<Record<string, EvalTool>>;

const roles = {
  tracker: {
    instructions: "Issue tracker of the ENG and OPS teams. Issue ids look like ENG-42.",
    tools: tracker,
  },
  "code-index": {
    instructions:
      "An index of this project's code. Call explore before searching or reading files: one call returns the matching symbols' source and their callers.",
    tools: codeIndex,
  },
} as const;
const Role = Schema.Literals(["tracker", "code-index"]);
const decodeArguments = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.String));

// The native MCP SDK owns the process stdio transport.
await Effect.runPromise(
  Effect.gen(function* () {
    const role = roles[yield* Schema.decodeUnknownEffect(Role)(process.argv[2])];
    const server = new Server(
      { name: process.argv[2] ?? "eval", version: "1.0.0" },
      { capabilities: { tools: {} }, instructions: role.instructions },
    );
    server.setRequestHandler("tools/list", () => ({
      tools: Object.entries(role.tools).map(([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: {
          type: "object" as const,
          properties: Object.fromEntries(
            Object.entries(tool.parameters).map(([parameter, description]) => [
              parameter,
              { type: "string", description },
            ]),
          ),
          required: Object.keys(tool.parameters),
        },
      })),
    }));
    server.setRequestHandler("tools/call", (request) =>
      Option.match(
        Arr.findFirst(Object.entries(role.tools), ([name]) => name === request.params.name),
        {
          onNone: () => ({
            isError: true,
            content: [{ type: "text" as const, text: "unknown tool" }],
          }),
          onSome: ([, tool]) => ({
            content: [
              {
                type: "text" as const,
                text: tool.answer(
                  Option.getOrElse(decodeArguments(request.params.arguments ?? {}), () => ({})),
                ),
              },
            ],
          }),
        },
      ),
    );
    yield* Effect.tryPromise({
      try: () => server.connect(new StdioServerTransport()),
      catch: (cause) => new Cause.UnknownError(cause),
    });
  }),
);
