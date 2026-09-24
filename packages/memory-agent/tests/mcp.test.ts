import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";
import { Effect } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { McpServers, mcpToolName } from "../src/mcp/servers.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { PermissionReviews } from "../src/permissions/reviews.ts";
import { Projects } from "../src/projects/projects.ts";
import { approvalToolDefinitions, permissionReviewInterrupt } from "../src/tools/definitions.ts";
import { testRuntime } from "./support/runtime.ts";

const fakeMcp = fileURLToPath(new URL("./support/fake-mcp-server.mjs", import.meta.url));

async function until(condition: () => boolean, what: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** An `mcp.json` / `.mcp.json` file as tests write it, including entries the app must reject. */
interface McpJson {
  readonly mcpServers: Readonly<
    Record<
      string,
      {
        readonly type?: string;
        readonly command?: string;
        readonly args?: readonly string[];
        readonly env?: Readonly<Record<string, string>>;
        readonly url?: string;
        readonly headers?: Readonly<Record<string, string>>;
      }
    >
  >;
}

const writeJson = (path: string, value: McpJson) => writeFileSync(path, JSON.stringify(value));

async function mcpSetup() {
  const context = await testRuntime({ testProvider: {} });
  const log = join(context.base, "mcp-starts.log");
  const starts = () =>
    existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0;
  const fakeEntry = (extraEnv: Record<string, string> = {}) => ({
    command: process.execPath,
    args: [fakeMcp],
    env: { FAKE_MCP_LOG: log, ...extraEnv },
  });
  const servers = await context.runtime.runPromise(McpServers);
  const run = <A, E>(effect: Effect.Effect<A, E>) => context.runtime.runPromise(effect);
  return { ...context, log, starts, fakeEntry, servers, run };
}

describe("MCP servers", () => {
  test("concurrent discovery shares one tools/list request", async () => {
    const { project, fakeEntry, servers, run } = await mcpSetup();
    const listLog = join(project.root, "mcp-lists.log");
    writeJson(join(project.root, ".mcp.json"), {
      mcpServers: { fake: fakeEntry({ FAKE_MCP_LIST_LOG: listLog }) },
    });
    await run(servers.setTrusted(project, "project", "fake", true));
    const before = readFileSync(listLog, "utf8").trim().split("\n").length;

    const [left, right] = await Promise.all([
      run(servers.tools(project)),
      run(servers.tools(project)),
    ]);

    expect(left.map((tool) => tool.name)).toEqual(right.map((tool) => tool.name));
    expect(readFileSync(listLog, "utf8").trim().split("\n")).toHaveLength(before + 1);
  });

  test("removing a configured server closes its live process", async () => {
    const { project, log, fakeEntry, servers, run } = await mcpSetup();
    const config = join(project.root, ".mcp.json");
    writeJson(config, { mcpServers: { fake: fakeEntry() } });
    await run(servers.setTrusted(project, "project", "fake", true));
    const pid = Number(readFileSync(log, "utf8").trim().split(" ")[1]);
    writeJson(config, { mcpServers: {} });

    expect((await run(servers.overview(project))).servers).toEqual([]);
    await until(() => !processAlive(pid), "the removed MCP server to stop");
    expect(await run(servers.tools(project))).toEqual([]);
  });

  test("configured servers start only after the user trusts that exact configuration", async () => {
    const { project, storage, starts, fakeEntry, servers, run } = await mcpSetup();
    writeJson(join(storage, "mcp.json"), {
      mcpServers: {
        fake: fakeEntry({ API_TOKEN: "${NOT_SHOWN}" }),
        docs: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "x" } },
      },
    });
    writeJson(join(project.root, ".mcp.json"), { mcpServers: { docs: fakeEntry() } });

    const listed = await run(servers.overview(project));
    expect(listed.servers).toEqual([
      expect.objectContaining({
        scope: "global",
        name: "fake",
        transport: "stdio",
        envNames: ["FAKE_MCP_LOG", "API_TOKEN"],
        shadowed: false,
        state: { status: "untrusted" },
      }),
      expect.objectContaining({
        scope: "global",
        name: "docs",
        transport: "http",
        headerNames: ["Authorization"],
        shadowed: true,
      }),
      expect.objectContaining({ scope: "project", name: "docs", state: { status: "untrusted" } }),
    ]);
    // Values of the environment and headers never leave the server.
    expect(JSON.stringify(listed)).not.toContain("NOT_SHOWN");
    expect(await run(servers.tools(project))).toEqual([]);
    expect(starts()).toBe(0);

    // `fake` needs NOT_SHOWN, which the environment does not have: trusting reports why it failed.
    const failed = await run(servers.setTrusted(project, "global", "fake", true));
    expect(failed.servers[0]?.state).toEqual({
      status: "failed",
      error: expect.stringContaining("missing_env: NOT_SHOWN"),
    });

    const trusted = await run(servers.setTrusted(project, "project", "docs", true));
    expect(trusted.servers[2]?.state).toEqual({ status: "connected", tools: ["echo", "where"] });
    expect(starts()).toBe(1);
    const tools = await run(servers.tools(project));
    expect(tools.map((tool) => tool.name)).toEqual(["mcp_docs__echo", "mcp_docs__where"]);
    expect(starts()).toBe(1);

    // A changed configuration is not the one the user trusted.
    writeJson(join(project.root, ".mcp.json"), {
      mcpServers: { docs: { ...fakeEntry(), args: [fakeMcp, "--changed"] } },
    });
    const changed = await run(servers.overview(project));
    expect(changed.servers[2]?.state).toEqual({ status: "changed" });
    expect(await run(servers.tools(project))).toEqual([]);

    const untrusted = await run(servers.setTrusted(project, "project", "docs", false));
    expect(untrusted.servers[2]?.state).toEqual({ status: "untrusted" });
  });

  test("a server runs in the project with only the configured environment", async () => {
    const { project, fakeEntry, servers, run } = await mcpSetup();
    process.env.SHOULD_NOT_LEAK = "inherited";
    process.env.FAKE_TOKEN_SOURCE = "expanded-token";
    try {
      writeJson(join(project.root, ".mcp.json"), {
        mcpServers: { fake: fakeEntry({ FAKE_MCP_TOKEN: "${FAKE_TOKEN_SOURCE}" }) },
      });
      await run(servers.setTrusted(project, "project", "fake", true));
      const where = (await run(servers.tools(project))).find(
        (tool) => tool.name === mcpToolName("fake", "where"),
      );
      const result = await where?.execute?.({});
      expect(JSON.parse(String(result))).toEqual({
        cwd: project.root,
        token: "expanded-token",
        inheritedSecret: null,
      });
    } finally {
      delete process.env.SHOULD_NOT_LEAK;
      delete process.env.FAKE_TOKEN_SOURCE;
    }
  });

  test("invalid files and names are reported, not guessed", async () => {
    const { project, storage, servers, run } = await mcpSetup();
    writeFileSync(join(storage, "mcp.json"), "{ not json");
    writeJson(join(project.root, ".mcp.json"), { mcpServers: { "bad name!": { command: "x" } } });
    const listed = await run(servers.overview(project));
    expect(listed.servers).toEqual([]);
    expect(listed.files.map((file) => file.error !== null)).toEqual([true, true]);
  });

  test("tool names stay within the model's limits", () => {
    expect(mcpToolName("fs", "read file")).toBe("mcp_fs__read_file");
    const long = mcpToolName("server", "x".repeat(80));
    expect(long).toHaveLength(64);
    expect(long).toMatch(/^mcp_server__x+_[0-9a-f]{8}$/);
  });
});

describe("MCP tool calls in a chat", () => {
  async function chatSetup(mode: "ask" | "auto") {
    const context = await mcpSetup();
    writeJson(join(context.project.root, ".mcp.json"), {
      mcpServers: { fake: context.fakeEntry() },
    });
    await context.provider!.select(context.runtime);
    await context.runtime.runPromise(
      Effect.gen(function* () {
        yield* (yield* Projects).setPermissionMode(context.project.id, mode);
        yield* (yield* McpServers).setTrusted(context.project, "project", "fake", true);
      }),
    );
    const client = new ChatClient({
      tools: approvalToolDefinitions,
      interrupts: [permissionReviewInterrupt],
      connection: fetchServerSentEvents("http://127.0.0.1/api/chat", {
        fetchClient: (input, init) =>
          context.runtime.runPromise(
            Effect.flatMap(AgentChat, (agent) =>
              agent.handle(new Request(input, init), context.session.id),
            ),
          ),
      }),
    });
    const answer = () =>
      client
        .getMessages()
        .flatMap((message) =>
          message.role === "assistant"
            ? message.parts.flatMap((part) => (part.type === "text" ? [part.content] : []))
            : [],
        )
        .join("");
    const finished = async () => {
      await until(() => answer().includes("said"), "the answer");
      await until(() => !client.getIsLoading(), "the run to finish");
    };
    const [reviews, nodes] = await Promise.all([
      context.runtime.runPromise(PermissionReviews),
      context.runtime.runPromise(Nodes),
    ]);
    return { ...context, client, answer, finished, reviews, nodes };
  }

  test("ask mode asks before every MCP call and runs it once approved", async () => {
    const { client, answer, finished, reviews, nodes, session } = await chatSetup("ask");

    await client.sendMessage('call mcp_fake__echo {"text":"hi from mcp"}');
    await until(() => client.getInterrupts().length === 1, "the approval question");
    expect(client.getInterrupts()[0]).toMatchObject({
      kind: "generic",
      definitionId: "permission-review",
      payload: { toolName: "mcp_fake__echo" },
    });
    expect(nodes.session(session.id).some((node) => node.kind === "tool_result")).toBe(false);

    client.resolveInterrupts((item) => {
      if (item.kind === "generic") item.resolveInterrupt({ approved: true });
    });
    await finished();
    expect(answer()).toContain("echo: hi from mcp");
    expect(reviews.latest(session.id, "call-mcp_fake__echo")).toMatchObject({
      decision: "approved",
      decidedBy: "user",
    });
  });

  test("a declined MCP call never reaches the server", async () => {
    const { client, answer, finished, nodes, session } = await chatSetup("ask");

    await client.sendMessage('call mcp_fake__echo {"text":"never"}');
    await until(() => client.getInterrupts().length === 1, "the approval question");
    client.resolveInterrupts((item) => {
      if (item.kind === "generic") item.resolveInterrupt({ approved: false });
    });
    await finished();
    expect(answer()).not.toContain("echo: never");
    expect(
      nodes.session(session.id).find((node) => node.kind === "tool_result")?.detail,
    ).toMatchObject({ ok: false, permission: { decision: "denied" } });
  });

  test("auto mode sends MCP calls through the permission review", async () => {
    const { client, answer, finished, reviews, session } = await chatSetup("auto");

    await client.sendMessage('call mcp_fake__echo {"text":"reviewed"}');
    await finished();
    expect(client.getInterrupts()).toHaveLength(0);
    expect(answer()).toContain("echo: reviewed");
    expect(reviews.latest(session.id, "call-mcp_fake__echo")).toMatchObject({
      decision: "allow",
      decidedBy: "classifier",
    });
  });
});
