import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  StopReason,
} from "@agentclientprotocol/sdk";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { StorageRoot } from "../config/storage-root.ts";
import { Database } from "../db/database.ts";
import { expandVariables } from "../mcp/config.ts";
import type { Project } from "../projects/projects.ts";
import {
  AgentScope,
  globalAgentsFile,
  projectAgentsFile,
  readAgentsFile,
  type ConfiguredAgent,
} from "./config.ts";

/** After this many failed connection attempts in a row, reconnecting waits for the user (R17). */
export const maxConsecutiveFailures = 2;
const connectTimeoutMs = 30_000;
const retryDelayMs = 500;

/** Connection state of one external agent, as settings show it. */
export type AgentLinkState =
  | { readonly status: "idle" }
  | { readonly status: "connecting"; readonly failures: number }
  | { readonly status: "connected"; readonly agent: string | null; readonly loadSession: boolean }
  /** The last attempt failed; the next use (or the automatic reconnect) tries again. */
  | { readonly status: "retrying"; readonly failures: number; readonly error: string }
  /** Gave up after consecutive failures; only a manual reconnect tries again. */
  | { readonly status: "stopped"; readonly failures: number; readonly error: string };

export type AgentTrustState =
  | { readonly status: "untrusted" }
  | { readonly status: "changed" }
  | { readonly status: "trusted"; readonly link: AgentLinkState };

export interface ExternalAgentView {
  readonly scope: AgentScope;
  readonly name: string;
  readonly target: string;
  readonly envNames: readonly string[];
  readonly shadowed: boolean;
  readonly state: AgentTrustState;
}

export interface ExternalAgentsOverview {
  readonly files: ReadonlyArray<{ scope: AgentScope; path: string; error: string | null }>;
  readonly agents: readonly ExternalAgentView[];
}

/** One tool call the external agent reported, as far as it said. */
export interface ReportedToolCall {
  readonly title: string;
  readonly kind: string | null;
  readonly status: string | null;
}

export type ExternalPromptOutcome =
  | {
      readonly status: "completed" | "cancelled";
      readonly stopReason: StopReason;
      readonly answer: string;
      readonly toolCalls: readonly ReportedToolCall[];
    }
  /** The connection dropped mid-answer. What arrived is kept; the prompt is not sent again. */
  | {
      readonly status: "disconnected";
      readonly answer: string;
      readonly toolCalls: readonly ReportedToolCall[];
    }
  /** The agent answered the prompt with an error; the connection is still up. */
  | {
      readonly status: "failed";
      readonly error: string;
      readonly answer: string;
      readonly toolCalls: readonly ReportedToolCall[];
    }
  | { readonly status: "unavailable"; readonly reason: string };

export interface PromptHooks {
  readonly signal: AbortSignal;
  /** Every update, for callers that stream progress. */
  readonly onUpdate?: (update: SessionUpdate) => void;
  /** The agent's own permission request; true only for an explicit approval. */
  readonly askPermission: (request: RequestPermissionRequest) => Promise<boolean>;
}

interface SessionHandlers {
  onUpdate(update: SessionUpdate): void;
  askPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
}

interface Live {
  readonly child: ChildProcess;
  readonly connection: acp.ClientConnection;
  readonly agentName: string | null;
  readonly loadSession: boolean;
  /** Our session key → the agent's session id, valid only for this process. */
  readonly sessions: Map<string, string>;
  readonly handlers: Map<string, SessionHandlers>;
}

interface Link {
  readonly fingerprint: string;
  state: AgentLinkState;
  live: Live | null;
  attempt: Promise<Live> | null;
  failures: number;
}

const TrustRow = Schema.Struct({
  scope: AgentScope,
  name: Schema.String,
  fingerprint: Schema.String,
});
const decodeTrustRows = Schema.decodeUnknownSync(Schema.Array(TrustRow));

const DataMessage = Schema.Struct({ message: Schema.String });
const decodeDataMessage = Schema.decodeUnknownOption(DataMessage);

/** The message to show; an agent's JSON-RPC error often puts the real reason in `data.message`. */
const failureText = (error: Error) => {
  const detail =
    error instanceof acp.RequestError
      ? Option.match(decodeDataMessage(error.data), {
          onNone: () => "",
          onSome: (data) => `: ${data.message}`,
        })
      : "";
  return `${error.message}${detail}`.slice(0, 500);
};

/** The option that allows exactly this once, or rejects; a standing "always" is never chosen. */
function permissionAnswer(
  request: RequestPermissionRequest,
  approved: boolean,
): RequestPermissionResponse {
  const wanted = approved ? "allow_once" : "reject_once";
  const option = request.options.find((candidate) => candidate.kind === wanted);
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

const make = Effect.gen(function* () {
  const storage = yield* StorageRoot;
  const { sqlite } = yield* Database;
  const links = new Map<string, Link>();

  const selectTrust = sqlite.prepare(
    "SELECT scope, name, fingerprint FROM agent_trust WHERE project_id = '' OR project_id = ?",
  );
  const upsertTrust = sqlite.prepare(
    `INSERT INTO agent_trust (scope, project_id, name, fingerprint, trusted_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (scope, project_id, name) DO UPDATE SET fingerprint = excluded.fingerprint, trusted_at = excluded.trusted_at`,
  );
  const deleteTrust = sqlite.prepare(
    "DELETE FROM agent_trust WHERE scope = ? AND project_id = ? AND name = ?",
  );

  const linkKey = (project: Project, agent: ConfiguredAgent) =>
    `${project.id}/${agent.scope}/${agent.name}`;

  const configured = (project: Project) => {
    const global = readAgentsFile(globalAgentsFile(storage.path), "global");
    const local = readAgentsFile(projectAgentsFile(project.root), "project");
    const trust = decodeTrustRows(selectTrust.all(project.id));
    const localNames = new Set(local.agents.map((agent) => agent.name));
    return {
      files: [global, local].map((file, index) => ({
        scope: index === 0 ? ("global" as const) : ("project" as const),
        path: file.path,
        error: file.error,
      })),
      agents: [...global.agents, ...local.agents].map((agent) => ({
        agent,
        trusted:
          trust.find((row) => row.scope === agent.scope && row.name === agent.name)?.fingerprint ??
          null,
        shadowed: agent.scope === "global" && localNames.has(agent.name),
      })),
    };
  };

  const shutdown = (link: Link) => {
    const live = link.live;
    link.live = null;
    if (!live) return;
    live.connection.close();
    live.child.kill();
  };

  const startProcess = async (
    project: Project,
    agent: ConfiguredAgent,
    link: Link,
  ): Promise<Live> => {
    const env = {
      // The agent logs in its own official way; the app's ChatGPT and Kagi secrets are not passed.
      ...getDefaultEnvironment(),
      ...Object.fromEntries(
        Object.entries(agent.command.env).map(([name, value]) => [
          name,
          expandVariables(value, process.env),
        ]),
      ),
    };
    const child = spawn(
      expandVariables(agent.command.command, process.env),
      agent.command.args.map((arg) => expandVariables(arg, process.env)),
      { cwd: project.root, env, stdio: ["pipe", "pipe", "ignore"] },
    );
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await spawned;

    const handlers = new Map<string, SessionHandlers>();
    const connection = acp
      .client({ name: "context-generactive-agent" })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        handlers.get(ctx.params.sessionId)?.onUpdate(ctx.params.update);
      })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
        const handler = handlers.get(ctx.params.sessionId);
        return handler
          ? handler.askPermission(ctx.params)
          : { outcome: { outcome: "cancelled" } as const };
      })
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(child.stdin!),
          // SAFETY: a spawned child's stdout is a byte stream; Node types its web form loosely.
          Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
        ),
      );

    try {
      const timeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("initialize timed out")), connectTimeoutMs);
        timer.unref();
      });
      const initialized = await Promise.race([
        connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          // The agent works with its own tools; the app does not lend it file or terminal access.
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "context-generactive-agent", version: "0.0.0" },
        }),
        timeout,
      ]);
      const live: Live = {
        child,
        connection,
        agentName: initialized.agentInfo?.name ?? null,
        loadSession: initialized.agentCapabilities?.loadSession === true,
        sessions: new Map(),
        handlers,
      };
      child.once("exit", () => onLost(project, agent, link, live));
      void connection.closed.finally(() => onLost(project, agent, link, live));
      return live;
    } catch (error) {
      connection.close();
      child.kill();
      throw error;
    }
  };

  /** One connection attempt. Success clears the failure count; failure adds to it. */
  const attempt = (project: Project, agent: ConfiguredAgent, link: Link): Promise<Live> => {
    if (link.attempt) return link.attempt;
    link.state = { status: "connecting", failures: link.failures };
    const pending = startProcess(project, agent, link).then(
      (live) => {
        link.attempt = null;
        link.live = live;
        link.failures = 0;
        link.state = { status: "connected", agent: live.agentName, loadSession: live.loadSession };
        return live;
      },
      (error) => {
        link.attempt = null;
        link.failures += 1;
        const text = failureText(error instanceof Error ? error : new Error(String(error)));
        link.state =
          link.failures >= maxConsecutiveFailures
            ? { status: "stopped", failures: link.failures, error: text }
            : { status: "retrying", failures: link.failures, error: text };
        throw error;
      },
    );
    link.attempt = pending;
    return pending;
  };

  /**
   * A dropped connection is reconnected on its own until it fails twice in a row. Reconnecting
   * restores the connection only: nothing that was being asked is sent again.
   */
  const onLost = (project: Project, agent: ConfiguredAgent, link: Link, live: Live) => {
    if (link.live !== live) return;
    link.live = null;
    live.child.kill();
    const retry = (): void => {
      if (link.live || link.failures >= maxConsecutiveFailures) return;
      void attempt(project, agent, link).catch(() => {
        if (link.failures < maxConsecutiveFailures) setTimeout(retry, retryDelayMs).unref();
      });
    };
    setTimeout(retry, retryDelayMs).unref();
  };

  const linkFor = (project: Project, agent: ConfiguredAgent) => {
    const key = linkKey(project, agent);
    const existing = links.get(key);
    if (existing?.fingerprint === agent.fingerprint) return existing;
    if (existing) shutdown(existing);
    const link: Link = {
      fingerprint: agent.fingerprint,
      state: { status: "idle" },
      live: null,
      attempt: null,
      failures: 0,
    };
    links.set(key, link);
    return link;
  };

  /** The trusted, unchanged configuration of a named agent usable in this project. */
  const usable = (project: Project, name: string) =>
    configured(project).agents.find(
      (entry) =>
        entry.agent.name === name && !entry.shadowed && entry.trusted === entry.agent.fingerprint,
    )?.agent ?? null;

  const overview = (project: Project): ExternalAgentsOverview => {
    const { files, agents } = configured(project);
    return {
      files,
      agents: agents.map((entry) => ({
        scope: entry.agent.scope,
        name: entry.agent.name,
        target: [entry.agent.command.command, ...entry.agent.command.args].join(" "),
        envNames: Object.keys(entry.agent.command.env),
        shadowed: entry.shadowed,
        state:
          entry.trusted === null
            ? { status: "untrusted" }
            : entry.trusted !== entry.agent.fingerprint
              ? { status: "changed" }
              : {
                  status: "trusted",
                  link: links.get(linkKey(project, entry.agent))?.state ?? { status: "idle" },
                },
      })),
    };
  };

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const link of links.values()) shutdown(link);
    }),
  );

  return {
    overview: (project: Project) => Effect.sync(() => overview(project)),

    /** Names of agents a conversation in this project may use. */
    available: (project: Project) =>
      configured(project)
        .agents.filter((entry) => !entry.shadowed && entry.trusted === entry.agent.fingerprint)
        .map((entry) => entry.agent.name),

    /** Trusting records the exact configuration; nothing starts until it is used. */
    setTrusted: (project: Project, scope: AgentScope, name: string, trusted: boolean) =>
      Effect.sync(() => {
        const projectId = scope === "global" ? "" : project.id;
        const entry = configured(project).agents.find(
          (candidate) => candidate.agent.scope === scope && candidate.agent.name === name,
        );
        if (trusted && entry)
          upsertTrust.run(
            scope,
            projectId,
            name,
            entry.agent.fingerprint,
            new Date().toISOString(),
          );
        if (!trusted) {
          deleteTrust.run(scope, projectId, name);
          for (const [key, link] of links)
            if (key.endsWith(`/${scope}/${name}`)) {
              shutdown(link);
              links.delete(key);
            }
        }
        return overview(project);
      }),

    /** Manual reconnect: clears the failure count and tries once more. */
    reconnect: (project: Project, name: string) =>
      Effect.promise(async () => {
        const agent = usable(project, name);
        if (agent) {
          const link = linkFor(project, agent);
          shutdown(link);
          link.failures = 0;
          await attempt(project, agent, link).catch(() => undefined);
        }
        return overview(project);
      }),

    /**
     * Sends one prompt to the agent in the conversation `sessionKey` (a new agent session the first
     * time, or after the process restarted) and waits for its answer.
     */
    prompt: async (
      project: Project,
      name: string,
      sessionKey: string,
      text: string,
      hooks: PromptHooks,
    ): Promise<ExternalPromptOutcome> => {
      const agent = usable(project, name);
      if (!agent) return { status: "unavailable", reason: "not_trusted" };
      const link = linkFor(project, agent);
      if (link.failures >= maxConsecutiveFailures && !link.live && !link.attempt)
        return { status: "unavailable", reason: "stopped_after_failures" };
      let live: Live;
      try {
        live = link.live ?? (await attempt(project, agent, link));
      } catch (error) {
        return {
          status: "unavailable",
          reason: failureText(error instanceof Error ? error : new Error(String(error))),
        };
      }

      let sessionId = live.sessions.get(sessionKey);
      if (!sessionId) {
        try {
          const created = await live.connection.agent.request(acp.methods.agent.session.new, {
            cwd: project.root,
            mcpServers: [],
          });
          sessionId = created.sessionId;
          live.sessions.set(sessionKey, sessionId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { status: "unavailable", reason: `session_failed: ${message.slice(0, 200)}` };
        }
      }

      let answer = "";
      const toolCalls = new Map<string, ReportedToolCall>();
      live.handlers.set(sessionId, {
        onUpdate: (update) => {
          switch (update.sessionUpdate) {
            case "agent_message_chunk":
              if (update.content.type === "text") answer += update.content.text;
              break;
            case "tool_call":
              toolCalls.set(update.toolCallId, {
                title: update.title,
                kind: update.kind ?? null,
                status: update.status ?? null,
              });
              break;
            case "tool_call_update": {
              const known = toolCalls.get(update.toolCallId);
              toolCalls.set(update.toolCallId, {
                title: update.title ?? known?.title ?? "",
                kind: update.kind ?? known?.kind ?? null,
                status: update.status ?? known?.status ?? null,
              });
              break;
            }
            default:
              break;
          }
          hooks.onUpdate?.(update);
        },
        askPermission: async (request) =>
          permissionAnswer(request, await hooks.askPermission(request)),
      });
      const agentSession = sessionId;
      const cancel = () =>
        void live.connection.agent
          .notify(acp.methods.agent.session.cancel, { sessionId: agentSession })
          .catch(() => undefined);
      hooks.signal.addEventListener("abort", cancel, { once: true });
      try {
        const done = await live.connection.agent.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text }],
        });
        return {
          status: done.stopReason === "cancelled" ? "cancelled" : "completed",
          stopReason: done.stopReason,
          answer,
          toolCalls: [...toolCalls.values()],
        };
      } catch (error) {
        if (live.connection.signal.aborted || link.live !== live)
          return { status: "disconnected", answer, toolCalls: [...toolCalls.values()] };
        return {
          status: "failed",
          error: failureText(error instanceof Error ? error : new Error(String(error))),
          answer,
          toolCalls: [...toolCalls.values()],
        };
      } finally {
        hooks.signal.removeEventListener("abort", cancel);
        live.handlers.delete(agentSession);
      }
    },
  };
});

/** External ACP agents the app calls as a client (R17): Codex and others. */
export class ExternalAgents extends Context.Tag("memory-agent/ExternalAgents")<
  ExternalAgents,
  Effect.Effect.Success<typeof make>
>() {
  static readonly layer = Layer.scoped(ExternalAgents, make);
}
