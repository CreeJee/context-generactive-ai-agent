import {
  Client,
  isCallToolResult,
  isInputRequiredResult,
  type CallToolResult,
  type ContentBlock,
  type Tool as McpTool,
  type Transport,
} from "@modelcontextprotocol/client";
import { Cause, Effect, type JsonSchema, Match, Option, Predicate, Schema } from "effect";
import type { JsonValue } from "../json.ts";
import { optionalProperty } from "../optional-property.ts";

/**
 * The app's MCP client on the SDK, in place of `@tanstack/ai-mcp` (docs/effect-ai-migration.md
 * step 3), with what that client did for a run's tools: connect, list, call, and hand the result on
 * as TanStack did. It declares no elicitation or sampling, which the app does not answer.
 */

export class McpConnectFailed extends Schema.TaggedError<McpConnectFailed>()("McpConnectFailed", {
  cause: Schema.Defect(),
}) {
  override get message() {
    return "Failed to connect to MCP server";
  }
}

/** A call the server answered with an error, a request for input, or no result. */
export class McpToolFailed extends Schema.TaggedError<McpToolFailed>()("McpToolFailed", {
  message: Schema.String,
}) {}

/** MCP tool arguments. */
export type JsonObject = { readonly [key: string]: JsonValue };

/** Spec 2026-07-28 first; a server without it gets the 2025 `initialize` handshake. */
export const connectClient = (transport: Transport) =>
  Effect.suspend(() => {
    const client = new Client(
      { name: "context-generactive-agent", version: "0.0.1" },
      { versionNegotiation: { mode: "auto" } },
    );
    return Effect.tryPromise({
      try: () => client.connect(transport),
      catch: (cause) => McpConnectFailed.make({ cause }),
    }).pipe(
      Effect.tapError(() => Effect.ignore(Effect.tryPromise(() => client.close()))),
      Effect.as(client),
    );
  });

/** A tool that must run as a task (spec 2025-11-25). */
const requiresTask = (tool: McpTool) => tool.execution?.taskSupport === "required";

const supportsTaskCalls = (client: Client) =>
  client.getServerCapabilities()?.tasks?.requests?.tools?.call !== undefined;

/** Every page of the server's tools, without those that need tasks the server does not run. */
export const listTools = (client: Client) =>
  Effect.tryPromise({
    try: () => client.listTools(),
    catch: (cause) => new Cause.UnknownError(cause),
  }).pipe(
    Effect.map(({ tools }) =>
      tools.filter((tool) => !requiresTask(tool) || supportsTaskCalls(client)),
    ),
  );

/** The tool's input schema with `type` and `properties`, which some providers require. */
export const inputSchemaOf = (tool: McpTool): JsonSchema.JsonSchema => ({
  ...tool.inputSchema,
  type: tool.inputSchema.type ?? "object",
  properties: tool.inputSchema.properties ?? {},
});

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** One content block as TanStack handed it to the model. */
type ResultPart =
  | { readonly type: "text"; readonly content: string }
  | {
      readonly type: "image";
      readonly source: { readonly type: "data"; readonly value: string; readonly mimeType: string };
    };

const textPart = (content: string): ResultPart => ({ type: "text", content });

const partOf = Match.type<ContentBlock>().pipe(
  Match.discriminators("type")({
    text: (block) => Effect.succeed(textPart(block.text)),
    image: (block): Effect.Effect<ResultPart, Schema.SchemaError> =>
      Effect.succeed({
        type: "image",
        source: { type: "data", value: block.data, mimeType: block.mimeType },
      }),
    // A ui:// resource is for an MCP App to show, not for the model.
    resource: (block) =>
      block.resource.uri.startsWith("ui://")
        ? Effect.succeed(textPart(""))
        : Effect.map(encodeJson(block.resource), textPart),
  }),
  Match.orElse((block) => Effect.map(encodeJson(block), textPart)),
);

/** A single text as itself, other content as its parts; nothing as an empty text. */
const contentOf = (
  content: ReadonlyArray<ContentBlock>,
): Effect.Effect<string | ReadonlyArray<ResultPart>, Schema.SchemaError> => {
  const [only] = content;
  return content.length === 1 && only?.type === "text"
    ? Effect.succeed(only.text)
    : Effect.forEach(content, partOf).pipe(
        Effect.map((parts) =>
          parts.filter((part) => !(part.type === "text" && part.content === "")),
        ),
        Effect.map((parts) => (parts.length > 0 ? parts : "")),
      );
};

/** Structured content when the tool declares an output schema, else the content. */
const resultOf = (tool: McpTool) => (result: CallToolResult) =>
  result.isError === true
    ? contentOf(result.content).pipe(
        Effect.filterOrElse(Predicate.isString, encodeJson),
        Effect.flatMap((detail) =>
          Effect.fail(
            McpToolFailed.make({
              message:
                detail === ""
                  ? `MCP tool "${tool.name}" returned an error`
                  : `MCP tool "${tool.name}" returned an error: ${detail}`,
            }),
          ),
        ),
      )
    : tool.outputSchema !== undefined && result.structuredContent !== undefined
      ? Effect.succeed<unknown>(result.structuredContent)
      : contentOf(result.content);

const inputRequired = McpToolFailed.make({
  message: "The MCP server asked for input, which this app does not answer.",
});

const InputRequest = Schema.Struct({
  status: Schema.Literal("input_required"),
  inputRequests: Schema.Record(Schema.String, Schema.Unknown),
});
const isInputRequest = Schema.is(InputRequest);

/** A spec 2026 input request, or a spec 2025 task body that waits on input. */
const asksForInput = <A>(value: A) =>
  isInputRequiredResult(value) ||
  (isInputRequest(value) && Object.keys(value.inputRequests).length > 0);

const failIfAsking = <A>(value: A) =>
  Effect.succeed(value).pipe(Effect.filterOrFail(Predicate.not(asksForInput), () => inputRequired));

const passThrough = Schema.toStandardSchemaV1(Schema.Unknown);

const request = (client: Client, method: string, params: JsonObject) =>
  Effect.tryPromise({
    try: (signal) => client.request({ method, params }, passThrough, { signal }),
    catch: (cause) => new Cause.UnknownError(cause),
  });

const TaskState = Schema.Struct({
  taskId: Schema.NonEmptyString,
  status: Schema.Literals(["working", "input_required", "completed", "failed", "cancelled"]),
  pollInterval: Schema.optional(Schema.Unknown),
  statusMessage: Schema.optional(Schema.Unknown),
});
type TaskState = typeof TaskState.Type;
const decodeTask = Schema.decodeUnknownOption(TaskState);
const decodeCreatedTask = Schema.decodeUnknownOption(Schema.Struct({ task: TaskState }));

const defaultPollMs = 1_000;

const noResult = (tool: McpTool) =>
  McpToolFailed.make({
    message: `MCP task-required tool "${tool.name}" ended without a result or error`,
  });

/** Best effort and not awaited, as the call has already failed or stopped. */
const cancelTask = (client: Client, taskId: string) =>
  Effect.forkDetach(Effect.ignore(request(client, "tasks/cancel", { taskId }))).pipe(Effect.asVoid);

const finished =
  (tool: McpTool) =>
  <A>(value: A) =>
    isCallToolResult(value) ? Effect.succeed(value) : Effect.fail(noResult(tool));

/**
 * A spec 2025 task: `tasks/get` until it ends, then `tasks/result`. A call that stops early
 * cancels the task on the server.
 */
const taskCall = (client: Client, tool: McpTool, args: JsonObject) => {
  const polled = (task: TaskState): Effect.Effect<TaskState, McpToolFailed | Cause.UnknownError> =>
    Match.value(task.status).pipe(
      Match.when("working", () =>
        Effect.sleep(
          Predicate.isNumber(task.pollInterval) ? task.pollInterval : defaultPollMs,
        ).pipe(
          Effect.andThen(request(client, "tasks/get", { taskId: task.taskId })),
          Effect.flatMap(failIfAsking),
          Effect.flatMap((body) =>
            Option.match(decodeTask(body), {
              onNone: () => Effect.fail(noResult(tool)),
              onSome: polled,
            }),
          ),
        ),
      ),
      // The input request of a spec 2025 task comes as a request to the client, which this one
      // does not answer, so polling again would never end.
      Match.when("input_required", () =>
        cancelTask(client, task.taskId).pipe(
          Effect.andThen(
            Effect.fail(
              McpToolFailed.make({
                message: `MCP task "${task.taskId}" needs input. This client cannot answer a spec 2025 task input request.`,
              }),
            ),
          ),
        ),
      ),
      Match.orElse(() => Effect.succeed(task)),
    );
  const ended = (task: TaskState) =>
    task.status === "completed"
      ? request(client, "tasks/result", { taskId: task.taskId }).pipe(
          Effect.flatMap(failIfAsking),
          Effect.flatMap(finished(tool)),
        )
      : Effect.fail(
          McpToolFailed.make({
            message:
              Predicate.isString(task.statusMessage) && task.statusMessage !== ""
                ? `MCP task "${task.taskId}" ${task.status}: ${task.statusMessage}`
                : `MCP task "${task.taskId}" ${task.status}.`,
          }),
        );
  return request(client, "tools/call", { name: tool.name, arguments: args, task: {} }).pipe(
    Effect.flatMap(failIfAsking),
    Effect.flatMap((raw) =>
      Option.match(decodeCreatedTask(raw), {
        // A task body also carries `content`, so the task is read first.
        onSome: ({ task }) =>
          polled(task).pipe(
            Effect.onInterrupt(() => cancelTask(client, task.taskId)),
            Effect.flatMap(ended),
          ),
        onNone: () => finished(tool)(raw),
      }),
    ),
  );
};

const plainCall = (client: Client, tool: McpTool, args: JsonObject) =>
  Effect.tryPromise({
    try: (signal) =>
      client.callTool(
        { name: tool.name, arguments: args },
        {
          signal,
          allowInputRequired: true,
          // Only the input schema: the SDK sends the Mcp-Param-* headers from it, and without an
          // output schema it skips its output check, which would reject an input request.
          ...optionalProperty(
            "toolDefinition",
            client.getProtocolEra() === "modern"
              ? { name: tool.name, inputSchema: tool.inputSchema }
              : undefined,
          ),
        },
      ),
    catch: (cause) => new Cause.UnknownError(cause),
  }).pipe(Effect.flatMap(failIfAsking));

/** One call of a listed tool, with its result as TanStack handed it to the model. */
export const callTool = ({
  client,
  tool,
  args,
}: {
  readonly client: Client;
  readonly tool: McpTool;
  readonly args: JsonObject;
}) =>
  (requiresTask(tool) && client.getProtocolEra() !== "modern"
    ? taskCall(client, tool, args)
    : plainCall(client, tool, args)
  ).pipe(Effect.flatMap(resultOf(tool)));
