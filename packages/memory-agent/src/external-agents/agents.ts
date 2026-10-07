import { nativePromise, runNativeEffect } from "../runtime/native-effect.ts";
import { Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import type { ChildProcess } from "node:child_process";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  StopReason,
} from "@agentclientprotocol/sdk";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import spawn from "cross-spawn";
import {
  Cause,
  HashSet,
  MutableHashMap,
  DateTime,
  Clock,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Schema,
} from "effect";
import { StorageRoot } from "../config/storage-root.ts";
import { Database } from "../db/database.ts";
import { expandVariables } from "../mcp/config.ts";
import type { Project } from "../projects/projects.ts";
import { endChild } from "../runtime/host.ts";
import {
  AgentScope,
  globalAgentsFile,
  projectAgentsFile,
  readAgentsFile,
  type ConfiguredAgent,
} from "./config.ts";

/** After this many failed connection attempts in a row, reconnecting waits for the user (R17). */
export const maxConsecutiveFailures = 2;

export class ExternalAgentOperationFailed extends Data.TaggedError("ExternalAgentOperationFailed")<{
  readonly operation: "reconnect";
  readonly cause: unknown;
}> {}
const connectTimeoutMs = 30_000;
const retryDelayMs = 100;

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
  readonly sessions: MutableHashMap.MutableHashMap<string, string>;
  readonly handlers: MutableHashMap.MutableHashMap<string, SessionHandlers>;
}

interface Link {
  readonly fingerprint: string;
  retired: boolean;
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
// Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
const decodeTrustRows = EffectFunction.flow(
  Schema.decodeUnknownResult(Schema.Array(TrustRow)),
  Result.getOrThrow,
);

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
  return isTruthy(option)
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

const make = Effect.gen(function* () {
  const effectClock = yield* Clock.Clock;

  const storage = yield* StorageRoot;
  const { sqlite } = yield* Database;
  const links = MutableHashMap.empty<string, Link>();

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
    const localNames = HashSet.fromIterable(local.agents.map((agent) => agent.name));
    const agents = [...global.agents, ...local.agents].map((agent) => ({
      agent,
      trusted:
        trust.find((row) => row.scope === agent.scope && row.name === agent.name)?.fingerprint ??
        null,
      shadowed: agent.scope === "global" && HashSet.has(localNames, agent.name),
    }));
    const usableFingerprints = MutableHashMap.fromIterable(
      agents
        .filter((entry) => !entry.shadowed && entry.trusted === entry.agent.fingerprint)
        .map((entry) => [linkKey(project, entry.agent), entry.agent.fingerprint]),
    );
    for (const [key, link] of links) {
      if (!key.startsWith(`${project.id}/`)) continue;
      if (Option.getOrUndefined(MutableHashMap.get(usableFingerprints, key)) === link.fingerprint)
        continue;
      retire(link);
      MutableHashMap.remove(links, key);
    }
    return {
      files: [global, local].map((file, index) => ({
        scope: index === 0 ? ("global" as const) : ("project" as const),
        path: file.path,
        error: file.error,
      })),
      agents,
    };
  };

  const shutdown = (link: Link) => {
    const live = link.live;
    link.live = null;
    if (!(live !== null)) return;
    live.connection.close();
    endChild(live.child);
  };

  const retire = (link: Link) => {
    link.retired = true;
    shutdown(link);
  };

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const startProcess = (project: Project, agent: ConfiguredAgent, link: Link): Promise<Live> =>
    runNativeEffect(
      Effect.gen(function* () {
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
        // cross-spawn runs `npx` and other `.cmd` launchers on Windows, with arguments quoted for cmd.exe.
        const child = spawn(
          expandVariables(agent.command.command, process.env),
          agent.command.args.map((arg) => expandVariables(arg, process.env)),
          { cwd: project.root, env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
        );
        // Callback-to-Promise handshake for the native caller; cleanup stays at this protocol boundary.
        const spawned = new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        yield* nativePromise(() => spawned);

        const handlers = MutableHashMap.empty<string, SessionHandlers>();
        const connection = acp
          .client({ name: "context-generactive-agent" })
          .onNotification(acp.methods.client.session.update, (ctx) => {
            Option.getOrUndefined(MutableHashMap.get(handlers, ctx.params.sessionId))?.onUpdate(
              ctx.params.update,
            );
          })
          // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
          .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
            const handler = Option.getOrUndefined(
              MutableHashMap.get(handlers, ctx.params.sessionId),
            );
            return isTruthy(handler)
              ? handler.askPermission(ctx.params)
              : Promise.resolve({ outcome: { outcome: "cancelled" } as const });
          })
          .connect(
            acp.ndJsonStream(
              Writable.toWeb(child.stdin!),
              // SAFETY: a spawned child's stdout is a byte stream; Node types its web form loosely.
              Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
            ),
          );

        return yield* Effect.gen(function* () {
          const initialized = yield* nativePromise(() =>
            connection.agent.request(acp.methods.agent.initialize, {
              protocolVersion: acp.PROTOCOL_VERSION,
              clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false,
              },
              clientInfo: { name: "context-generactive-agent", version: "0.0.0" },
            }),
          ).pipe(
            Effect.timeoutOrElse({
              duration: connectTimeoutMs,
              orElse: () => Effect.fail(new Cause.UnknownError(new Error("initialize timed out"))),
            }),
          );
          const live: Live = {
            child,
            connection,
            agentName: initialized.agentInfo?.name ?? null,
            loadSession: initialized.agentCapabilities?.loadSession === true,
            sessions: MutableHashMap.empty(),
            handlers,
          };
          child.once("exit", () => onLost(project, agent, link, live));
          void connection.closed.finally(() => onLost(project, agent, link, live));
          return live;
        }).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              connection.close();
              endChild(child);
            }),
          ),
        );
      }),
    );

  /** One connection attempt. Success clears the failure count; failure adds to it. */
  const attempt = (project: Project, agent: ConfiguredAgent, link: Link): Promise<Live> => {
    if (isTruthy(link.attempt)) return link.attempt;
    link.state = { status: "connecting", failures: link.failures };
    const pending = startProcess(project, agent, link).then(
      (live) => {
        link.attempt = null;
        if (link.retired) {
          live.connection.close();
          endChild(live.child);
          return live;
        }
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
    if (link.retired || link.live !== live) return;
    link.live = null;
    endChild(live.child);
    const retry = (): void => {
      if (link.retired || link.live !== null || link.failures >= maxConsecutiveFailures) return;
      void attempt(project, agent, link).catch(() => {
        // Native callback heartbeat/debounce timing remains at the protocol boundary.
        if (link.failures < maxConsecutiveFailures) setTimeout(retry, retryDelayMs).unref();
      });
    };
    // Native callback heartbeat/debounce timing remains at the protocol boundary.
    setTimeout(retry, retryDelayMs).unref();
  };

  const linkFor = (project: Project, agent: ConfiguredAgent) => {
    const key = linkKey(project, agent);
    const existing = Option.getOrUndefined(MutableHashMap.get(links, key));
    if (existing?.fingerprint === agent.fingerprint) return existing;
    if (isTruthy(existing)) retire(existing);
    const link: Link = {
      fingerprint: agent.fingerprint,
      retired: false,
      state: { status: "idle" },
      live: null,
      attempt: null,
      failures: 0,
    };
    MutableHashMap.set(links, key, link);
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
                  link: Option.getOrUndefined(
                    MutableHashMap.get(links, linkKey(project, entry.agent)),
                  )?.state ?? { status: "idle" },
                },
      })),
    };
  };

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const link of MutableHashMap.values(links)) retire(link);
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
        if (trusted && isTruthy(entry))
          upsertTrust.run(
            scope,
            projectId,
            name,
            entry.agent.fingerprint,
            DateTime.formatIso(DateTime.makeUnsafe(effectClock.currentTimeMillisUnsafe())),
          );
        if (!trusted) {
          deleteTrust.run(scope, projectId, name);
          for (const [key, link] of links)
            if (key.endsWith(`/${scope}/${name}`)) {
              retire(link);
              MutableHashMap.remove(links, key);
            }
        }
        return overview(project);
      }),

    /** Manual reconnect: clears the failure count and tries once more. */
    reconnect: (project: Project, name: string) =>
      Effect.gen(function* () {
        const agent = usable(project, name);
        if (!isTruthy(agent)) return overview(project);
        const link = linkFor(project, agent);
        shutdown(link);
        link.failures = 0;
        yield* Effect.tryPromise({
          try: () => attempt(project, agent, link),
          catch: (cause) => new ExternalAgentOperationFailed({ operation: "reconnect", cause }),
        }).pipe(Effect.catchTag("ExternalAgentOperationFailed", () => Effect.void));
        return overview(project);
      }),

    /**
     * Sends one prompt to the agent in the conversation `sessionKey` (a new agent session the first
     * time, or after the process restarted) and waits for its answer.
     */
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    prompt: (
      project: Project,
      name: string,
      sessionKey: string,
      text: string,
      hooks: PromptHooks,
    ): Promise<ExternalPromptOutcome> =>
      runNativeEffect(
        Effect.gen(function* () {
          const agent = usable(project, name);
          if (!isTruthy(agent)) return { status: "unavailable" as const, reason: "not_trusted" };
          const link = linkFor(project, agent);
          if (
            link.failures >= maxConsecutiveFailures &&
            !isTruthy(link.live) &&
            !isTruthy(link.attempt)
          )
            return { status: "unavailable" as const, reason: "stopped_after_failures" };
          const connected = yield* Effect.result(
            nativePromise(() =>
              link.live === null ? attempt(project, agent, link) : Promise.resolve(link.live),
            ),
          );
          if (Result.isFailure(connected)) {
            const error = connected.failure.cause;
            return {
              status: "unavailable" as const,
              reason: failureText(error instanceof Error ? error : new Error(String(error))),
            };
          }
          const live = connected.success;

          let sessionId = Option.getOrUndefined(MutableHashMap.get(live.sessions, sessionKey));
          if (!isTruthy(sessionId)) {
            const created = yield* Effect.result(
              nativePromise(() =>
                live.connection.agent.request(acp.methods.agent.session.new, {
                  cwd: project.root,
                  mcpServers: [],
                }),
              ),
            );
            if (Result.isFailure(created)) {
              const error = created.failure.cause;
              const message = error instanceof Error ? error.message : String(error);
              return {
                status: "unavailable" as const,
                reason: `session_failed: ${message.slice(0, 200)}`,
              };
            }
            sessionId = created.success.sessionId;
            MutableHashMap.set(live.sessions, sessionKey, sessionId);
          }

          let answer = "";
          const toolCalls = MutableHashMap.empty<string, ReportedToolCall>();
          MutableHashMap.set(live.handlers, sessionId, {
            onUpdate: (update) => {
              switch (update.sessionUpdate) {
                case "agent_message_chunk":
                  if (update.content.type === "text") answer += update.content.text;
                  break;
                case "tool_call":
                  MutableHashMap.set(toolCalls, update.toolCallId, {
                    title: update.title,
                    kind: update.kind ?? null,
                    status: update.status ?? null,
                  });
                  break;
                case "tool_call_update": {
                  const known = Option.getOrUndefined(
                    MutableHashMap.get(toolCalls, update.toolCallId),
                  );
                  MutableHashMap.set(toolCalls, update.toolCallId, {
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
            // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
            askPermission: (request) =>
              runNativeEffect(
                nativePromise(() => hooks.askPermission(request)).pipe(
                  Effect.map((answer) => permissionAnswer(request, answer)),
                ),
              ),
          });
          const agentSession = sessionId;
          const cancel = () =>
            void live.connection.agent
              .notify(acp.methods.agent.session.cancel, { sessionId: agentSession })
              .catch(() => undefined);
          hooks.signal.addEventListener("abort", cancel, { once: true });
          return yield* Effect.gen(function* () {
            const outcome = yield* Effect.result(
              nativePromise(() =>
                live.connection.agent.request(acp.methods.agent.session.prompt, {
                  sessionId: agentSession,
                  prompt: [{ type: "text", text }],
                }),
              ),
            );
            if (Result.isSuccess(outcome))
              return {
                status:
                  outcome.success.stopReason === "cancelled"
                    ? ("cancelled" as const)
                    : ("completed" as const),
                stopReason: outcome.success.stopReason,
                answer,
                toolCalls: [...MutableHashMap.values(toolCalls)],
              };
            if (live.connection.signal.aborted || link.live !== live)
              return {
                status: "disconnected" as const,
                answer,
                toolCalls: [...MutableHashMap.values(toolCalls)],
              };
            const error = outcome.failure.cause;
            return {
              status: "failed" as const,
              error: failureText(error instanceof Error ? error : new Error(String(error))),
              answer,
              toolCalls: [...MutableHashMap.values(toolCalls)],
            };
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                hooks.signal.removeEventListener("abort", cancel);
                MutableHashMap.remove(live.handlers, agentSession);
              }),
            ),
          );
        }),
      ),
  };
});

/** External ACP agents the app calls as a client (R17): Codex and others. */
export class ExternalAgents extends Context.Service<ExternalAgents, Effect.Success<typeof make>>()(
  "memory-agent/external-agents/agents/ExternalAgents",
) {
  static readonly layer = Layer.effect(ExternalAgents, make);
}
