import { Effect, FileSystem, Path, Schema } from "effect";
import { expect, vi } from "vite-plus/test";
import { McpServers, mcpToolName } from "../../src/mcp/servers.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { PermissionReviews } from "../../src/permissions/reviews.ts";
import { Projects } from "../../src/projects/projects.ts";
import { Sessions } from "../../src/sessions/sessions.ts";
import { chatClient, scopedCallId, sdk, sessionScopedResponder } from "../support/chat-client.ts";
import { selectTestModel } from "../support/provider.ts";
import { TestEnv, testAgent } from "../support/test-env.ts";
import { waitUntil } from "../support/wait-until.ts";

const until = (condition: () => boolean, what: string) => waitUntil(condition, what, 6_000);

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

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const writeJson = Effect.fnUntraced(function* (file: string, value: McpJson) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(file, yield* encodeJson(value));
});

const lines = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return (yield* fs.exists(file))
    ? (yield* fs.readFileString(file)).trim().split("\n").filter(Boolean)
    : [];
});

/**
 * The fake stdio MCP server for one project. Each start is logged in the project, so tests sharing
 * an agent count only their own starts.
 */
const fakeServer = Effect.fnUntraced(function* (root: string) {
  const path = yield* Path.Path;
  const script = yield* path.fromFileUrl(new URL("../support/fake-mcp-server.ts", import.meta.url));
  const log = path.join(root, "mcp-starts.log");
  return {
    script,
    log,
    config: path.join(root, ".mcp.json"),
    starts: Effect.map(lines(log), (started) => started.length),
    entry: (extraEnv: Record<string, string> = {}) => ({
      command: process.execPath,
      args: [script],
      env: { FAKE_MCP_LOG: log, ...extraEnv },
    }),
  };
});

/** Trust and live connections belong to a project, so each test registers its own. */
const freshProject = Effect.gen(function* () {
  const env = yield* TestEnv;
  const fs = yield* FileSystem.FileSystem;
  const project = yield* (yield* Projects).add(
    yield* fs.makeTempDirectory({ directory: env.base }),
  );
  return { project, fake: yield* fakeServer(project.root) };
});

/** Point the process environment at test values for the rest of the test. */
const stubEnv = (values: Record<string, string>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
    }),
    () => Effect.sync(() => vi.unstubAllEnvs()),
  );

testAgent()("MCP servers of a project", (it) => {
  it.effect("concurrent discovery shares one tools/list request", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const servers = yield* McpServers;
      const { project, fake } = yield* freshProject;
      const listLog = path.join(project.root, "mcp-lists.log");
      yield* writeJson(fake.config, {
        mcpServers: { fake: fake.entry({ FAKE_MCP_LIST_LOG: listLog }) },
      });
      yield* servers.setTrusted(project, "project", "fake", true);
      const before = (yield* lines(listLog)).length;
      const [left, right] = yield* Effect.all([servers.tools(project), servers.tools(project)], {
        concurrency: "unbounded",
      });
      expect(left.map((tool) => tool.name)).toEqual(right.map((tool) => tool.name));
      expect(yield* lines(listLog)).toHaveLength(before + 1);
    }),
  );

  it.effect("removing a configured server closes its live process", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const servers = yield* McpServers;
      const { project, fake } = yield* freshProject;
      yield* writeJson(fake.config, { mcpServers: { fake: fake.entry() } });
      yield* servers.setTrusted(project, "project", "fake", true);
      const pid = Number((yield* fs.readFileString(fake.log)).trim().split(" ")[1]);
      yield* writeJson(fake.config, { mcpServers: {} });
      expect((yield* servers.overview(project)).servers).toEqual([]);
      yield* until(() => !processAlive(pid), "the removed MCP server to stop");
      expect(yield* servers.tools(project)).toEqual([]);
    }),
  );

  it.effect("a server runs in the project with only the configured environment", () =>
    Effect.gen(function* () {
      const servers = yield* McpServers;
      const { project, fake } = yield* freshProject;
      yield* stubEnv({ SHOULD_NOT_LEAK: "inherited", FAKE_TOKEN_SOURCE: "expanded-token" });
      yield* writeJson(fake.config, {
        mcpServers: { fake: fake.entry({ FAKE_MCP_TOKEN: "${FAKE_TOKEN_SOURCE}" }) },
      });
      yield* servers.setTrusted(project, "project", "fake", true);
      const where = (yield* servers.tools(project)).find(
        (tool) => tool.name === mcpToolName("fake", "where"),
      );
      const result = yield* sdk(() => Promise.resolve(where?.execute?.({})));
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
      ).toEqual({ cwd: project.root, token: "expanded-token", inheritedSecret: null });
    }),
  );
});

// The global `mcp.json` and its trust are shared by every project, so these tests own an agent.
testAgent()("MCP trust of the global and project configuration", (it) => {
  it.effect("configured servers start only after the user trusts that exact configuration", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { project, storage } = yield* TestEnv;
      const servers = yield* McpServers;
      const fake = yield* fakeServer(project.root);
      yield* writeJson(path.join(storage, "mcp.json"), {
        mcpServers: {
          fake: fake.entry({ API_TOKEN: "${NOT_SHOWN}" }),
          docs: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "x" } },
        },
      });
      yield* writeJson(fake.config, { mcpServers: { docs: fake.entry() } });
      const listed = yield* servers.overview(project);
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
      expect(yield* encodeJson(listed)).not.toContain("NOT_SHOWN");
      expect(yield* servers.tools(project)).toEqual([]);
      expect(yield* fake.starts).toBe(0);
      // `fake` needs NOT_SHOWN, which the environment does not have: trusting reports why it failed.
      const failed = yield* servers.setTrusted(project, "global", "fake", true);
      expect(failed.servers[0]?.state).toEqual({
        status: "failed",
        error: expect.stringContaining("missing_env: NOT_SHOWN"),
      });
      const trusted = yield* servers.setTrusted(project, "project", "docs", true);
      expect(trusted.servers[2]?.state).toEqual({ status: "connected", tools: ["echo", "where"] });
      expect(yield* fake.starts).toBe(1);
      const tools = yield* servers.tools(project);
      expect(tools.map((tool) => tool.name)).toEqual(["mcp_docs__echo", "mcp_docs__where"]);
      expect(yield* fake.starts).toBe(1);
      // A changed configuration is not the one the user trusted.
      yield* writeJson(fake.config, {
        mcpServers: { docs: { ...fake.entry(), args: [fake.script, "--changed"] } },
      });
      expect((yield* servers.overview(project)).servers[2]?.state).toEqual({ status: "changed" });
      expect(yield* servers.tools(project)).toEqual([]);
      const untrusted = yield* servers.setTrusted(project, "project", "docs", false);
      expect(untrusted.servers[2]?.state).toEqual({ status: "untrusted" });
    }),
  );
});

testAgent()("MCP configuration errors", (it) => {
  it.effect("invalid files and names are reported, not guessed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { project, storage } = yield* TestEnv;
      yield* fs.writeFileString(path.join(storage, "mcp.json"), "{ not json");
      yield* writeJson(path.join(project.root, ".mcp.json"), {
        mcpServers: { "bad name!": { command: "x" } },
      });
      const listed = yield* (yield* McpServers).overview(project);
      expect(listed.servers).toEqual([]);
      expect(listed.files.map((file) => file.error !== null)).toEqual([true, true]);
    }),
  );
});

/** A trusted fake server in a fresh project whose permission mode is `mode`, and a chat page. */
const mcpChat = Effect.fnUntraced(function* (mode: "ask" | "auto") {
  const { project, fake } = yield* freshProject;
  yield* writeJson(fake.config, { mcpServers: { fake: fake.entry() } });
  yield* selectTestModel();
  yield* (yield* Projects).setPermissionMode(project.id, mode);
  yield* (yield* McpServers).setTrusted(project, "project", "fake", true);
  const session = (yield* (yield* Sessions).create(project.id)).id;
  const page = yield* chatClient(session, "send");
  return {
    ...page,
    session,
    callId: scopedCallId("call-mcp_fake__echo", session),
    finished: page.answered("mcp_fake__echo said", "the answer"),
  };
});

// Interrupt IDs are unique across the database, so the model scopes its call IDs to the session.
testAgent({ testProvider: { responder: sessionScopedResponder } })(
  "MCP tool calls in a chat",
  (it) => {
    it.effect("ask mode asks before every MCP call and runs it once approved", () =>
      Effect.gen(function* () {
        const { client, text, send, pendingInterrupt, finished, session, callId } =
          yield* mcpChat("ask");
        const nodes = yield* Nodes;
        yield* send('call mcp_fake__echo {"text":"hi from mcp"}');
        yield* pendingInterrupt;
        expect(client.getInterrupts()[0]).toMatchObject({
          kind: "generic",
          definitionId: "permission-review",
          payload: { toolName: "mcp_fake__echo" },
        });
        expect(nodes.session(session).some((node) => node.kind === "tool_result")).toBe(false);
        client.resolveInterrupts((item) => {
          if (item.kind === "generic") item.resolveInterrupt({ approved: true });
        });
        yield* finished;
        expect(text()).toContain("echo: hi from mcp");
        expect(yield* (yield* PermissionReviews).latest(session, callId)).toMatchObject({
          decision: "approved",
          decidedBy: "user",
        });
      }),
    );

    it.effect("a declined MCP call never reaches the server", () =>
      Effect.gen(function* () {
        const { client, text, send, pendingInterrupt, finished, session } = yield* mcpChat("ask");
        yield* send('call mcp_fake__echo {"text":"never"}');
        yield* pendingInterrupt;
        client.resolveInterrupts((item) => {
          if (item.kind === "generic") item.resolveInterrupt({ approved: false });
        });
        yield* finished;
        expect(text()).not.toContain("echo: never");
        expect(
          (yield* Nodes).session(session).find((node) => node.kind === "tool_result")?.detail,
        ).toMatchObject({ ok: false, permission: { decision: "denied" } });
      }),
    );

    it.effect("auto mode sends MCP calls through the permission review", () =>
      Effect.gen(function* () {
        const { client, text, send, finished, session, callId } = yield* mcpChat("auto");
        yield* send('call mcp_fake__echo {"text":"reviewed"}');
        yield* finished;
        expect(client.getInterrupts()).toHaveLength(0);
        expect(text()).toContain("echo: reviewed");
        expect(yield* (yield* PermissionReviews).latest(session, callId)).toMatchObject({
          decision: "allow",
          decidedBy: "classifier",
        });
      }),
    );
  },
);
