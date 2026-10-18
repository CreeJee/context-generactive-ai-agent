import { nativePromise, runNativeEffect } from "../runtime/native-effect.ts";
import { SqlClient, SqlError, SqlSchema } from "effect/sql";
import { isTruthy } from "../truthy.ts";
import * as acp from "@agentclientprotocol/sdk";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  StopReason,
} from "@agentclientprotocol/sdk";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { SdkStreams } from "../acp/web-streams.ts";
import {
  Cause,
  HashSet,
  MutableHashMap,
  DateTime,
  Clock,
  Context,
  Effect,
  FiberMap,
  FileSystem,
  Path,
  Scope,
  Exit,
  Layer,
  Option,
  Result,
  Schema,
} from "effect";
import { StorageRoot } from "../config/storage-root.ts";
import { isPlatformError } from "effect/PlatformError";
import { MissingVariable, expandVariablesResult } from "../mcp/config.ts";
import { SecretRedactor } from "../secrets/redactor.ts";
import type {
  ConfigFileFailureCode,
  ExternalAgentFailureCode,
  ShownFailure,
} from "../runtime/shown-failure.ts";
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

export class ExternalAgentOperationFailed extends Schema.TaggedError<ExternalAgentOperationFailed>()(
  "ExternalAgentOperationFailed",
  { operation: Schema.Literal("reconnect"), cause: Schema.Defect() },
) {}

/** The agent process started but did not answer `initialize` in time. */
export class ExternalAgentInitializeTimedOut extends Schema.TaggedError<ExternalAgentInitializeTimedOut>()(
  "ExternalAgentInitializeTimedOut",
  {},
) {
  override get message() {
    return "initialize timed out";
  }
}
const connectTimeoutMs = 30_000;
const retryDelayMs = 100;

/** Connection state of one external agent, as settings show it. */
export type AgentLinkState =
  | { readonly status: "idle" }
  | { readonly status: "connecting"; readonly failures: number }
  | { readonly status: "connected"; readonly agent: string | null; readonly loadSession: boolean }
  /** The last attempt failed; the next use (or the automatic reconnect) tries again. */
  | {
      readonly status: "retrying";
      readonly failures: number;
      readonly failure: ShownFailure<ExternalAgentFailureCode>;
    }
  /** Gave up after consecutive failures; only a manual reconnect tries again. */
  | {
      readonly status: "stopped";
      readonly failures: number;
      readonly failure: ShownFailure<ExternalAgentFailureCode>;
    };

export type AgentTrustState =
  | { readonly status: "untrusted" }
  | { readonly status: "changed" }
  | { readonly status: "trusted"; readonly link: AgentLinkState };

export interface ExternalAgentView {
  readonly scope: AgentScope;
  readonly name: string;
  /** `command args…` as configured, with secrets hidden; `null` when they could not be checked. */
  readonly target: string | null;
  readonly envNames: readonly string[];
  readonly shadowed: boolean;
  readonly state: AgentTrustState;
}

export interface ExternalAgentsOverview {
  readonly files: ReadonlyArray<{
    scope: AgentScope;
    path: string;
    error: ShownFailure<ConfigFileFailureCode> | null;
  }>;
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
      readonly failure: ShownFailure<ExternalAgentFailureCode>;
      readonly answer: string;
      readonly toolCalls: readonly ReportedToolCall[];
    }
  | { readonly status: "unavailable"; readonly failure: ShownFailure<ExternalAgentFailureCode> };

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
  readonly dispose: () => void;
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

const DataMessage = Schema.Struct({ message: Schema.String });
const decodeDataMessage = Schema.decodeUnknownOption(DataMessage);

/** The agent's own text; its JSON-RPC error often puts the real reason in `data.message`. */
const failureText = (error: acp.RequestError) =>
  Option.match(decodeDataMessage(error.data), {
    onNone: () => error.message,
    onSome: (data) => `${error.message}: ${data.message}`,
  });

/** What a rejected request or attempt said. */
const rejectionText = (error: Error) =>
  error instanceof acp.RequestError ? failureText(error) : error.message;

/** Promise rejections can be any value; what the agent did not throw as an error has no class. */
const rejectionError = (rejection: Cause.UnknownError) =>
  rejection.cause instanceof Error ? rejection.cause : new Error(String(rejection.cause));

const isMissingVariable = Schema.is(MissingVariable);
const isInitializeTimedOut = Schema.is(ExternalAgentInitializeTimedOut);

/**
 * Why a connection attempt failed, from what it rejected with. `detail` is not redacted yet: the
 * owner hides secrets before anyone sees it.
 */
const connectFailure = (error: Error): ShownFailure<ExternalAgentFailureCode> =>
  isMissingVariable(error)
    ? { code: "missing_env", detail: error.variable }
    : isInitializeTimedOut(error)
      ? { code: "initialize_timed_out", detail: null }
      : isPlatformError(error)
        ? { code: "spawn_failed", detail: error.message }
        : error instanceof acp.RequestError
          ? { code: "agent_error", detail: failureText(error) }
          : { code: "connection_failed", detail: rejectionText(error) };

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

/** Resolve Windows launchers using the same cmd metacharacter and npm shim escaping contract as cross-spawn. */
export const agentCommandInvocation = Effect.fn("ExternalAgent.commandInvocation")(
  function* (options: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
  }) {
    let command = options.command;
    let args = [...options.args];
    let shell: string | undefined;
    if ((options.platform ?? process.platform) !== "win32") return { command, args, shell };
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { cwd, env } = options;
    const resolve = Effect.fnUntraced(function* (name: string) {
      const extensions = ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")];
      const directories = /[\\/]/.test(name)
        ? [cwd]
        : [cwd, ...(env.Path ?? env.PATH ?? "").split(";")];
      for (const directory of directories) {
        for (const extension of extensions) {
          const candidate = path.resolve(cwd, directory, `${name}${extension}`);
          // A candidate that cannot be inspected is not a launcher.
          const isFile = yield* fs.stat(candidate).pipe(
            Effect.map((info) => info.type === "File"),
            Effect.catchTag("PlatformError", () => Effect.succeed(false)),
          );
          if (isFile) return candidate;
        }
      }
      return undefined;
    });
    let executable = yield* resolve(command);
    if (executable !== undefined && !/\.(com|exe)$/i.test(executable)) {
      const firstLine = yield* fs.readFileString(executable).pipe(
        Effect.map((text) => text.split(/\r?\n/, 1)[0] ?? ""),
        // An unreadable launcher has no shebang to follow.
        Effect.catchTag("PlatformError", () => Effect.succeed("")),
      );
      if (firstLine.startsWith("#!")) {
        const [interpreterPath, ...flags] = firstLine.slice(2).trim().split(/\s+/);
        let interpreter = interpreterPath?.split("/").at(-1);
        if (interpreter === "env") {
          if (flags[0] === "-S") flags.shift();
          interpreter = flags.shift();
        }
        if (interpreter !== undefined && interpreter.length > 0) {
          command = interpreter;
          args = [...flags, executable, ...args];
          executable = yield* resolve(command);
        }
      }
    }
    if (executable === undefined || !/\.(com|exe)$/i.test(executable)) {
      const meta = /([()\][%!^"`<>&|;, *?])/g;
      const doubleEscape =
        executable !== undefined && /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(executable);
      const quote = (arg: string) => {
        let value =
          `"${arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, "$1$1")}"`.replace(
            meta,
            "^$1",
          );
        if (doubleEscape) value = value.replace(meta, "^$1");
        return value;
      };
      command = [path.normalize(command).replace(meta, "^$1"), ...args.map(quote)].join(" ");
      args = [];
      shell = env.ComSpec ?? env.COMSPEC ?? "cmd.exe";
    }
    return { command, args, shell };
  },
);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serviceScope = yield* Scope.Scope;

  const storage = yield* StorageRoot;
  const sql = yield* SqlClient.SqlClient;
  const redactor = yield* SecretRedactor;
  const links = MutableHashMap.empty<string, Link>();
  const retries = yield* FiberMap.make<string, void, never>();
  const context = yield* Effect.context<never>();
  const runCallback = Effect.runForkWith(context);

  const selectTrust = SqlSchema.findAll({
    Request: Schema.String,
    Result: TrustRow,
    execute: (projectId) => sql`
      SELECT scope, name, fingerprint FROM agent_trust
      WHERE project_id = '' OR project_id = ${projectId}`,
  });

  const linkKey = (project: Project, agent: ConfiguredAgent) =>
    `${project.id}/${agent.scope}/${agent.name}`;

  const configured = Effect.fn("ExternalAgents.configured")(function* (project: Project) {
    const global = yield* readAgentsFile(globalAgentsFile(storage.path), "global").pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    );
    const local = yield* readAgentsFile(projectAgentsFile(project.root), "project").pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    );
    const trust = yield* selectTrust(project.id);
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
    const files = yield* Effect.forEach([global, local], (file, index) =>
      // A decode error can quote the file, environment values included.
      Effect.map(
        file.error === null ? Effect.succeed(null) : redactor.hideDetail(file.error),
        (error) => ({
          scope: index === 0 ? ("global" as const) : ("project" as const),
          path: file.path,
          error,
        }),
      ),
    );
    return { files, agents };
  });

  const shutdown = (link: Link) => {
    const live = link.live;
    link.live = null;
    if (!(live !== null)) return;
    live.connection.close();
    live.dispose();
  };

  const retire = (link: Link) => {
    link.retired = true;
    shutdown(link);
  };

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const startProcess = (project: Project, agent: ConfiguredAgent, link: Link): Promise<Live> =>
    runNativeEffect(
      Effect.gen(function* () {
        const expand = (value: string) =>
          Effect.fromResult(expandVariablesResult(value, process.env));
        const env = {
          // The agent logs in its own official way; the app's ChatGPT and Kagi secrets are not passed.
          ...getDefaultEnvironment(),
          ...Object.fromEntries(
            yield* Effect.forEach(Object.entries(agent.command.env), ([name, value]) =>
              Effect.map(expand(value), (expanded) => [name, expanded] as const),
            ),
          ),
        };
        const owner = yield* Scope.fork(serviceScope, "parallel");
        const { command, args, shell } = yield* agentCommandInvocation({
          command: yield* expand(agent.command.command),
          args: yield* Effect.forEach(agent.command.args, expand),
          cwd: project.root,
          env,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        const child = yield* spawner
          .spawn(
            ChildProcess.make(command, args, {
              cwd: project.root,
              env,
              extendEnv: false,
              stderr: "ignore",
              windowsHide: true,
              stdin: { stream: "pipe", endOnDone: false },
              shell,
              forceKillAfter: "3 seconds",
            }),
          )
          .pipe(
            Effect.provideService(Scope.Scope, owner),
            Effect.onError(() => Scope.close(owner, Exit.void)),
          );
        const dispose = () => {
          runCallback(Scope.close(owner, Exit.void));
        };
        const streamContext = yield* Layer.build(
          SdkStreams.layer({
            input: child.stdout,
            output: child.stdin,
            closeOutput: Scope.close(owner, Exit.void),
          }),
        ).pipe(Effect.provideService(Scope.Scope, owner));
        const streams = Context.get(streamContext, SdkStreams);

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
          .connect(acp.ndJsonStream(streams.writable, streams.readable));

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
              orElse: () => Effect.fail(new ExternalAgentInitializeTimedOut()),
            }),
          );
          const live: Live = {
            dispose,
            connection,
            agentName: initialized.agentInfo?.name ?? null,
            loadSession: initialized.agentCapabilities?.loadSession === true,
            sessions: MutableHashMap.empty(),
            handlers,
          };
          yield* child.exitCode.pipe(
            Effect.onExit(() => Effect.sync(() => onLost(project, agent, link, live))),
            // Any end of the process is the lost connection handled above.
            Effect.catchTag("PlatformError", () => Effect.void),
            Effect.forkIn(owner),
          );
          void connection.closed.finally(() => onLost(project, agent, link, live));
          return live;
        }).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              connection.close();
              dispose();
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
          live.dispose();
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
        const failures = link.failures;
        return runNativeEffect(
          redactor.hideDetail(
            connectFailure(error instanceof Error ? error : new Error(String(error))),
          ),
        ).then((failure) => {
          // A newer attempt owns the state now.
          if (link.attempt === null)
            link.state =
              failures >= maxConsecutiveFailures
                ? { status: "stopped", failures, failure }
                : { status: "retrying", failures, failure };
          throw error;
        });
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
    live.dispose();
    const retry = Effect.gen(function* () {
      while (!link.retired && link.live === null && link.failures < maxConsecutiveFailures) {
        yield* Effect.sleep(retryDelayMs);
        if (link.retired || link.live !== null || link.failures >= maxConsecutiveFailures) return;
        const outcome = yield* Effect.result(nativePromise(() => attempt(project, agent, link)));
        if (Result.isSuccess(outcome)) return;
      }
    });
    runCallback(FiberMap.run(retries, linkKey(project, agent), retry, { onlyIfMissing: true }));
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
  const usable = Effect.fn("ExternalAgents.usable")(function* (project: Project, name: string) {
    return (
      (yield* configured(project)).agents.find(
        (entry) =>
          entry.agent.name === name && !entry.shadowed && entry.trusted === entry.agent.fingerprint,
      )?.agent ?? null
    );
  });

  const overview = Effect.fn("ExternalAgents.overview")(function* (
    project: Project,
  ): Effect.fn.Return<ExternalAgentsOverview, SqlError.SqlError | Schema.SchemaError> {
    const { files, agents } = yield* configured(project);
    const views = yield* Effect.forEach(agents, (entry) =>
      Effect.map(
        // A command line can carry a key (`--api-key=…`); the page gets it hidden.
        redactor.shownDetail([entry.agent.command.command, ...entry.agent.command.args].join(" ")),
        (target): ExternalAgentView => ({
          scope: entry.agent.scope,
          name: entry.agent.name,
          target,
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
        }),
      ),
    );
    return { files, agents: views };
  });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const link of MutableHashMap.values(links)) retire(link);
    }),
  );

  return {
    overview,

    /** Names of agents a conversation in this project may use. */
    available: (project: Project) =>
      Effect.map(configured(project), (config) =>
        config.agents
          .filter((entry) => !entry.shadowed && entry.trusted === entry.agent.fingerprint)
          .map((entry) => entry.agent.name),
      ),

    /** Trusting records the exact configuration; nothing starts until it is used. */
    setTrusted: (project: Project, scope: AgentScope, name: string, trusted: boolean) =>
      Effect.gen(function* () {
        const projectId = scope === "global" ? "" : project.id;
        const entry = (yield* configured(project)).agents.find(
          (candidate) => candidate.agent.scope === scope && candidate.agent.name === name,
        );
        if (trusted && isTruthy(entry)) {
          const trustedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
          yield* sql`
            INSERT INTO agent_trust (scope, project_id, name, fingerprint, trusted_at)
            VALUES (${scope}, ${projectId}, ${name}, ${entry.agent.fingerprint}, ${trustedAt})
            ON CONFLICT (scope, project_id, name) DO UPDATE
            SET fingerprint = excluded.fingerprint, trusted_at = excluded.trusted_at`;
        }
        if (!trusted) {
          yield* sql`
            DELETE FROM agent_trust
            WHERE scope = ${scope} AND project_id = ${projectId} AND name = ${name}`;
          for (const [key, link] of links)
            if (key.endsWith(`/${scope}/${name}`)) {
              retire(link);
              MutableHashMap.remove(links, key);
            }
        }
        return yield* overview(project);
      }),

    /** Manual reconnect: clears the failure count and tries once more. */
    reconnect: (project: Project, name: string) =>
      Effect.gen(function* () {
        const agent = yield* usable(project, name);
        if (!isTruthy(agent)) return yield* overview(project);
        const link = linkFor(project, agent);
        shutdown(link);
        link.failures = 0;
        yield* Effect.tryPromise({
          try: () => attempt(project, agent, link),
          catch: (cause) => new ExternalAgentOperationFailed({ operation: "reconnect", cause }),
        }).pipe(Effect.catchTag("ExternalAgentOperationFailed", () => Effect.void));
        return yield* overview(project);
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
          const agent = yield* usable(project, name);
          if (!isTruthy(agent))
            return {
              status: "unavailable" as const,
              failure: { code: "not_trusted" as const, detail: null },
            };
          const link = linkFor(project, agent);
          if (
            link.failures >= maxConsecutiveFailures &&
            !isTruthy(link.live) &&
            !isTruthy(link.attempt)
          )
            return {
              status: "unavailable" as const,
              failure: { code: "stopped_after_failures" as const, detail: null },
            };
          const connected = yield* Effect.result(
            nativePromise(() =>
              link.live === null ? attempt(project, agent, link) : Promise.resolve(link.live),
            ),
          );
          if (Result.isFailure(connected))
            return {
              status: "unavailable" as const,
              failure: yield* redactor.hideDetail(
                connectFailure(rejectionError(connected.failure)),
              ),
            };
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
              const error = rejectionError(created.failure);
              return {
                status: "unavailable" as const,
                failure: yield* redactor.hideDetail({
                  code: "session_failed" as const,
                  detail: rejectionText(error),
                }),
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
            const error = rejectionError(outcome.failure);
            return {
              status: "failed" as const,
              failure: yield* redactor.hideDetail({
                code: "agent_error" as const,
                detail: rejectionText(error),
              }),
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
