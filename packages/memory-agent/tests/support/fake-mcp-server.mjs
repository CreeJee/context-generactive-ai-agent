// A small stdio MCP server for tests. Records each start in $FAKE_MCP_LOG when set.
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

if (process.env.FAKE_MCP_LOG) appendFileSync(process.env.FAKE_MCP_LOG, `start ${process.pid}\n`);

const server = new Server({ name: "fake", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
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
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case "echo":
      return {
        content: [{ type: "text", text: `echo: ${String(request.params.arguments?.text)}` }],
      };
    case "where":
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              cwd: process.cwd(),
              token: process.env.FAKE_MCP_TOKEN ?? null,
              inheritedSecret: process.env.SHOULD_NOT_LEAK ?? null,
            }),
          },
        ],
      };
    default:
      return { isError: true, content: [{ type: "text", text: "unknown tool" }] };
  }
});

await server.connect(new StdioServerTransport());
