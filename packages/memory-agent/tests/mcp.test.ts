import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";
import { Cause, Effect, FileSystem, Path, Schema } from "effect";
import { it } from "@effect/vitest";
import { withTestPlatform } from "./support/platform.ts";
import { selectTestModel } from "./support/provider.ts";
import { waitUntil } from "./support/wait-until.ts";
import { describe, expect, test, vi } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { McpServers, mcpToolName } from "../src/mcp/servers.ts";
import { Nodes } from "../src/memory/nodes.ts";
import { PermissionReviews } from "../src/permissions/reviews.ts";
import { Projects } from "../src/projects/projects.ts";
import { approvalToolDefinitions, permissionReviewInterrupt } from "../src/tools/definitions.ts";
import { testRuntime } from "./support/runtime.ts";

const sdkCall = Effect.fn("mcpTest.sdkCall")(function* <A>(operation: () => A | PromiseLike<A>) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});
const until = (condition: () => boolean, what: string) => waitUntil(condition, what, 6000);

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

const writeJson = Effect.fn("mcpTest.writeJson")(function* (file: string, value: McpJson) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(
    file,
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value),
  );
});

const mcpSetup = Effect.fn("mcpTest.setup")(function* () {
  const context = yield* sdkCall(() => testRuntime({ testProvider: {} }));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fakeMcp = yield* path.fromFileUrl(new URL("./support/fake-mcp-server.ts", import.meta.url));
  const log = path.join(context.base, "mcp-starts.log");
  const starts = Effect.fn("mcpTest.starts")(function* () {
    return (yield* fs.exists(log))
      ? (yield* fs.readFileString(log)).trim().split("\n").filter(Boolean).length
      : 0;
  });
  const fakeEntry = (extraEnv: Record<string, string> = {}) => ({
    command: process.execPath,
    args: [fakeMcp],
    env: { FAKE_MCP_LOG: log, ...extraEnv },
  });
  const servers = yield* Effect.provideContext(McpServers, yield* context.runtime.contextEffect);
  const run = Effect.fn("mcpTest.run")(function* <A, E>(effect: Effect.Effect<A, E>) {
    return yield* Effect.provideContext(effect, yield* context.runtime.contextEffect);
  });
  return { ...context, fakeMcp, log, starts, fakeEntry, servers, run };
});

describe("MCP servers", () => {
  it.live("concurrent discovery shares one tools/list request", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { project, fakeEntry, servers, run } = yield* mcpSetup();
      const listLog = path.join(project.root, "mcp-lists.log");
      yield* writeJson(path.join(project.root, ".mcp.json"), {
        mcpServers: { fake: fakeEntry({ FAKE_MCP_LIST_LOG: listLog }) },
      });
      yield* run(servers.setTrusted(project, "project", "fake", true));
      const before = (yield* fs.readFileString(listLog)).trim().split("\n").length;
      const [left, right] = yield* Effect.all(
        [run(servers.tools(project)), run(servers.tools(project))],
        { concurrency: "unbounded" },
      );
      expect(left.map((tool) => tool.name)).toEqual(right.map((tool) => tool.name));
      expect((yield* fs.readFileString(listLog)).trim().split("\n")).toHaveLength(before + 1);
    }).pipe(withTestPlatform),
  );

  it.live("removing a configured server closes its live process", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { project, log, fakeEntry, servers, run } = yield* mcpSetup();
      const config = path.join(project.root, ".mcp.json");
      yield* writeJson(config, { mcpServers: { fake: fakeEntry() } });
      yield* run(servers.setTrusted(project, "project", "fake", true));
      const pid = Number((yield* fs.readFileString(log)).trim().split(" ")[1]);
      yield* writeJson(config, { mcpServers: {} });
      expect((yield* run(servers.overview(project))).servers).toEqual([]);
      yield* until(() => !processAlive(pid), "the removed MCP server to stop");
      expect(yield* run(servers.tools(project))).toEqual([]);
    }).pipe(withTestPlatform),
  );

  it.live("configured servers start only after the user trusts that exact configuration", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { project, storage, starts, fakeEntry, fakeMcp, servers, run } = yield* mcpSetup();
      yield* writeJson(path.join(storage, "mcp.json"), {
        mcpServers: {
          fake: fakeEntry({ API_TOKEN: "${NOT_SHOWN}" }),
          docs: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "x" } },
        },
      });
      yield* writeJson(path.join(project.root, ".mcp.json"), { mcpServers: { docs: fakeEntry() } });
      const listed = yield* run(servers.overview(project));
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
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(listed),
      ).not.toContain("NOT_SHOWN");
      expect(yield* run(servers.tools(project))).toEqual([]);
      expect(yield* starts()).toBe(0);
      // `fake` needs NOT_SHOWN, which the environment does not have: trusting reports why it failed.
      const failed = yield* run(servers.setTrusted(project, "global", "fake", true));
      expect(failed.servers[0]?.state).toEqual({
        status: "failed",
        error: expect.stringContaining("missing_env: NOT_SHOWN"),
      });
      const trusted = yield* run(servers.setTrusted(project, "project", "docs", true));
      expect(trusted.servers[2]?.state).toEqual({ status: "connected", tools: ["echo", "where"] });
      expect(yield* starts()).toBe(1);
      const tools = yield* run(servers.tools(project));
      expect(tools.map((tool) => tool.name)).toEqual(["mcp_docs__echo", "mcp_docs__where"]);
      expect(yield* starts()).toBe(1);
      // A changed configuration is not the one the user trusted.
      yield* writeJson(path.join(project.root, ".mcp.json"), {
        mcpServers: { docs: { ...fakeEntry(), args: [fakeMcp, "--changed"] } },
      });
      const changed = yield* run(servers.overview(project));
      expect(changed.servers[2]?.state).toEqual({ status: "changed" });
      expect(yield* run(servers.tools(project))).toEqual([]);
      const untrusted = yield* run(servers.setTrusted(project, "project", "docs", false));
      expect(untrusted.servers[2]?.state).toEqual({ status: "untrusted" });
    }).pipe(withTestPlatform),
  );

  it.live("a server runs in the project with only the configured environment", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { project, fakeEntry, servers, run } = yield* mcpSetup();
      vi.stubEnv("SHOULD_NOT_LEAK", "inherited");
      vi.stubEnv("FAKE_TOKEN_SOURCE", "expanded-token");
      try {
        yield* writeJson(path.join(project.root, ".mcp.json"), {
          mcpServers: { fake: fakeEntry({ FAKE_MCP_TOKEN: "${FAKE_TOKEN_SOURCE}" }) },
        });
        yield* run(servers.setTrusted(project, "project", "fake", true));
        const where = (yield* run(servers.tools(project))).find(
          (tool) => tool.name === mcpToolName("fake", "where"),
        );
        const result = yield* sdkCall(() => where?.execute?.({}));
        expect(
          yield* Schema.decodeEffect(
            Schema.fromJsonString(
              Schema.Struct({
                cwd: Schema.String,
                token: Schema.String,
                inheritedSecret: Schema.Null,
              }),
            ),
          )(String(result)),
        ).toEqual({
          cwd: project.root,
          token: "expanded-token",
          inheritedSecret: null,
        });
      } finally {
        vi.unstubAllEnvs();
      }
    }).pipe(withTestPlatform),
  );

  it.live("invalid files and names are reported, not guessed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { project, storage, servers, run } = yield* mcpSetup();
      yield* fs.writeFileString(path.join(storage, "mcp.json"), "{ not json");
      yield* writeJson(path.join(project.root, ".mcp.json"), {
        mcpServers: { "bad name!": { command: "x" } },
      });
      const listed = yield* run(servers.overview(project));
      expect(listed.servers).toEqual([]);
      expect(listed.files.map((file) => file.error !== null)).toEqual([true, true]);
    }).pipe(withTestPlatform),
  );

  test("tool names stay within the model's limits", () => {
    expect(mcpToolName("fs", "read file")).toBe("mcp_fs__read_file");
    const long = mcpToolName("server", "x".repeat(80));
    expect(long).toHaveLength(64);
    expect(long).toMatch(/^mcp_server__x+_[0-9a-f]{8}$/);
  });
});

describe("MCP tool calls in a chat", () => {
  const chatSetup = Effect.fn("mcpTest.chatSetup")(function* (mode: "ask" | "auto") {
    const path = yield* Path.Path;
    const context = yield* mcpSetup();
    yield* writeJson(path.join(context.project.root, ".mcp.json"), {
      mcpServers: { fake: context.fakeEntry() },
    });
    yield* Effect.provideContext(selectTestModel(), yield* context.runtime.contextEffect);
    yield* Effect.provideContext(
      Effect.gen(function* () {
        yield* (yield* Projects).setPermissionMode(context.project.id, mode);
        yield* (yield* McpServers).setTrusted(context.project, "project", "fake", true);
      }),
      yield* context.runtime.contextEffect,
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
    yield* Effect.addFinalizer(() => Effect.sync(() => client.dispose()));
    const answer = () =>
      client
        .getMessages()
        .flatMap((message) =>
          message.role === "assistant"
            ? message.parts.flatMap((part) => (part.type === "text" ? [part.content] : []))
            : [],
        )
        .join("");
    const finished = Effect.fn("mcpTest.finished")(function* () {
      yield* until(() => answer().includes("said"), "the answer");
      yield* until(() => !client.getIsLoading(), "the run to finish");
    });
    const [reviews, nodes] = yield* Effect.provideContext(
      Effect.all([PermissionReviews, Nodes]),
      yield* context.runtime.contextEffect,
    );
    return { ...context, client, answer, finished, reviews, nodes };
  });

  it.live("ask mode asks before every MCP call and runs it once approved", () =>
    Effect.gen(function* () {
      const { client, answer, finished, reviews, nodes, session } = yield* chatSetup("ask");
      yield* sdkCall(() => client.sendMessage('call mcp_fake__echo {"text":"hi from mcp"}'));
      yield* until(() => client.getInterrupts().length === 1, "the approval question");
      expect(client.getInterrupts()[0]).toMatchObject({
        kind: "generic",
        definitionId: "permission-review",
        payload: { toolName: "mcp_fake__echo" },
      });
      expect(nodes.session(session.id).some((node) => node.kind === "tool_result")).toBe(false);
      client.resolveInterrupts((item) => {
        if (item.kind === "generic") item.resolveInterrupt({ approved: true });
      });
      yield* finished();
      expect(answer()).toContain("echo: hi from mcp");
      expect(reviews.latest(session.id, "call-mcp_fake__echo")).toMatchObject({
        decision: "approved",
        decidedBy: "user",
      });
    }).pipe(withTestPlatform),
  );

  it.live("a declined MCP call never reaches the server", () =>
    Effect.gen(function* () {
      const { client, answer, finished, nodes, session } = yield* chatSetup("ask");
      yield* sdkCall(() => client.sendMessage('call mcp_fake__echo {"text":"never"}'));
      yield* until(() => client.getInterrupts().length === 1, "the approval question");
      client.resolveInterrupts((item) => {
        if (item.kind === "generic") item.resolveInterrupt({ approved: false });
      });
      yield* finished();
      expect(answer()).not.toContain("echo: never");
      expect(
        nodes.session(session.id).find((node) => node.kind === "tool_result")?.detail,
      ).toMatchObject({ ok: false, permission: { decision: "denied" } });
    }).pipe(withTestPlatform),
  );

  it.live("auto mode sends MCP calls through the permission review", () =>
    Effect.gen(function* () {
      const { client, answer, finished, reviews, session } = yield* chatSetup("auto");
      yield* sdkCall(() => client.sendMessage('call mcp_fake__echo {"text":"reviewed"}'));
      yield* finished();
      expect(client.getInterrupts()).toHaveLength(0);
      expect(answer()).toContain("echo: reviewed");
      expect(reviews.latest(session.id, "call-mcp_fake__echo")).toMatchObject({
        decision: "allow",
        decidedBy: "classifier",
      });
    }).pipe(withTestPlatform),
  );
});
