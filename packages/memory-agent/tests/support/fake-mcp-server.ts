import { NodeFileSystem } from "@effect/platform-node";
import { Cause, Config, Effect, FileSystem, Layer, Schema } from "effect";
import { isTruthy } from "../../src/truthy.ts";
// A small stdio MCP server for tests. Records each start in $FAKE_MCP_LOG when set.
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

// The native MCP SDK owns the process stdio transport; its callbacks await domain Effects.
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(NodeFileSystem.layer);
      const fs = yield* Effect.provideContext(FileSystem.FileSystem, services);
      const runNative = Effect.runPromiseWith(yield* Effect.context());
      const startLog = yield* Config.String("FAKE_MCP_LOG").pipe(Config.withDefault(""));
      const listLog = yield* Config.String("FAKE_MCP_LIST_LOG").pipe(Config.withDefault(""));
      const token = yield* Config.String("FAKE_MCP_TOKEN").pipe(Config.withDefault(null));
      const inheritedSecret = yield* Config.String("SHOULD_NOT_LEAK").pipe(
        Config.withDefault(null),
      );
      // A spec 2025 task tool, `later`, which answers once its task ends.
      const tasks = yield* Config.Boolean("FAKE_MCP_TASKS").pipe(Config.withDefault(false));
      const echoDescription = yield* Config.String("FAKE_MCP_ECHO_DESCRIPTION").pipe(
        Config.withDefault("Repeats text."),
      );
      if (isTruthy(startLog))
        yield* fs.writeFileString(startLog, "start " + process.pid + "\n", { flag: "a" });
      const server = new Server(
        { name: "fake", version: "1.0.0" },
        {
          capabilities: tasks
            ? { tools: {}, tasks: { requests: { tools: { call: {} } } } }
            : { tools: {} },
          instructions: "Call echo to repeat text back.",
        },
      );
      const task = (status: "working" | "completed") => ({
        taskId: "task-1",
        status,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUpdatedAt: "2026-01-01T00:00:00.000Z",
        ttl: null,
        pollInterval: 10,
      });
      // The SDK types no longer list the task methods, so they are registered as custom ones.
      const taskRequest = {
        params: Schema.toStandardSchemaV1(Schema.Struct({ taskId: Schema.String })),
      };
      if (tasks) {
        server.setRequestHandler("tasks/get", taskRequest, () => task("completed"));
        server.setRequestHandler("tasks/result", taskRequest, () => ({
          content: [{ type: "text", text: "later: done" }],
        }));
      }

      server.setRequestHandler("tools/list", () =>
        runNative(
          Effect.gen(function* () {
            if (isTruthy(listLog)) yield* fs.writeFileString(listLog, "list\n", { flag: "a" });
            return {
              tools: [
                {
                  name: "echo",
                  description: echoDescription,
                  inputSchema: {
                    type: "object",
                    properties: { text: { type: "string" } },
                    required: ["text"],
                  },
                },
                {
                  name: "where",
                  description: "Working directory and whether the configured secret arrived.",
                  inputSchema: { type: "object", properties: {} },
                  annotations: { readOnlyHint: true },
                },
                ...(tasks
                  ? [
                      {
                        name: "later",
                        description: "Answers once its task ends.",
                        inputSchema: { type: "object" as const, properties: {} },
                        execution: { taskSupport: "required" as const },
                      },
                    ]
                  : []),
              ],
            };
          }),
        ),
      );

      server.setRequestHandler("tools/call", (request) =>
        runNative(
          Effect.gen(function* () {
            switch (request.params.name) {
              case "later":
                return { task: task("working"), content: [] };
              case "echo":
                return {
                  content: [
                    { type: "text", text: `echo: ${String(request.params.arguments?.text)}` },
                  ],
                };
              case "where":
                return {
                  content: [
                    {
                      type: "text",
                      text: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                        cwd: process.cwd(),
                        token,
                        inheritedSecret,
                      }),
                    },
                  ],
                };
              default:
                return { isError: true, content: [{ type: "text", text: "unknown tool" }] };
            }
          }),
        ),
      );

      yield* Effect.tryPromise({
        try: () => server.connect(new StdioServerTransport()),
        catch: (cause) => new Cause.UnknownError(cause),
      });
    }),
  ),
);
