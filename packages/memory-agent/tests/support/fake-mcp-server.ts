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
      if (isTruthy(startLog))
        yield* fs.writeFileString(startLog, "start " + process.pid + "\n", { flag: "a" });
      const server = new Server(
        { name: "fake", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );

      server.setRequestHandler("tools/list", () =>
        runNative(
          Effect.gen(function* () {
            if (isTruthy(listLog)) yield* fs.writeFileString(listLog, "list\n", { flag: "a" });
            return {
              tools: [
                {
                  name: "echo",
                  description: "Repeats text.",
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
                },
              ],
            };
          }),
        ),
      );

      server.setRequestHandler("tools/call", (request) =>
        runNative(
          Effect.gen(function* () {
            switch (request.params.name) {
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
