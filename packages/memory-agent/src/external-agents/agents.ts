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
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { SdkStreams } from "../acp/web-streams.ts";
import {
  Array as EffectArray,
  Cause,
  Function as EffectFunction,
  HashMap,
  HashSet,
  Match,
  MutableHashMap,
  DateTime,
  Clock,
  Context,
  Data,
  Effect,
  Fiber,
  FiberMap,
  FileSystem,
  Path,
  Ref,
  Scope,
  Exit,
  Layer,
  Option,
  Result,
  Schema,
  SynchronizedRef,
} from "effect";
import { StorageRoot } from "../config/storage-root.ts";
import { isPlatformError, type PlatformError } from "effect/PlatformError";
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
export type AgentLinkState = Data.TaggedEnum<{
  idle: {};
  connecting: { readonly failures: number };
  connected: { readonly agent: string | null; readonly loadSession: boolean };
  /** The last attempt failed; the next use (or the automatic reconnect) tries again. */
  retrying: {
    readonly failures: number;
    readonly failure: ShownFailure<ExternalAgentFailureCode>;
  };
  /** Gave up after consecutive failures; only a manual reconnect tries again. */
  stopped: {
    readonly failures: number;
    readonly failure: ShownFailure<ExternalAgentFailureCode>;
  };
}>;
export const AgentLinkState = Data.taggedEnum<AgentLinkState>();

export type AgentTrustState = Data.TaggedEnum<{
  untrusted: {};
  changed: {};
  trusted: { readonly link: AgentLinkState };
}>;
export const AgentTrustState = Data.taggedEnum<AgentTrustState>();

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

/** The agent ended its answer, on its own or because the prompt was cancelled. */
type AnsweredPrompt = {
  readonly stopReason: StopReason;
  readonly answer: string;
  readonly toolCalls: readonly ReportedToolCall[];
};

export type ExternalPromptOutcome = Data.TaggedEnum<{
  completed: AnsweredPrompt;
  cancelled: AnsweredPrompt;
  /** The connection dropped mid-answer. What arrived is kept; the prompt is not sent again. */
  disconnected: {
    readonly answer: string;
    readonly toolCalls: readonly ReportedToolCall[];
  };
  /** The agent answered the prompt with an error; the connection is still up. */
  failed: {
    readonly failure: ShownFailure<ExternalAgentFailureCode>;
    readonly answer: string;
    readonly toolCalls: readonly ReportedToolCall[];
  };
  unavailable: { readonly failure: ShownFailure<ExternalAgentFailureCode> };
}>;
export const ExternalPromptOutcome = Data.taggedEnum<ExternalPromptOutcome>();

export interface PromptHooks {
  /** Every update, for callers that stream progress. */
  readonly onUpdate?: (update: SessionUpdate) => void;
  /**
   * The agent's own permission request; true only for an explicit approval. `signal` aborts when
   * the turn is interrupted.
   */
  readonly askPermission: (
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ) => Effect.Effect<boolean>;
}

interface SessionHandlers {
  onUpdate(update: SessionUpdate): void;
  askPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
}

interface Live {
  /** Ends the process and its streams. */
  readonly dispose: Effect.Effect<void>;
  readonly connection: acp.ClientConnection;
  readonly agentName: string | null;
  readonly loadSession: boolean;
  /** Our session key → the agent's session id, valid only for this process. */
  readonly sessions: Ref.Ref<HashMap.HashMap<string, string>>;
  readonly handlers: MutableHashMap.MutableHashMap<string, SessionHandlers>;
}

/** What a connection attempt fails with. */
type AttemptFailure =
  | MissingVariable
  | PlatformError
  | ExternalAgentInitializeTimedOut
  | Cause.UnknownError;

/** A link's state, replaced as a whole under its lock. */
interface LinkState {
  readonly retired: boolean;
  /** What settings show. */
  readonly shown: AgentLinkState;
  readonly live: Live | null;
  /** The connection attempt in flight, which callers meanwhile share. */
  readonly attempt: Fiber.Fiber<Live, AttemptFailure> | null;
  readonly failures: number;
}

interface Link {
  readonly fingerprint: string;
  readonly state: SynchronizedRef.SynchronizedRef<LinkState>;
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

/** What an attempt failed with: the agent's own rejection, or the typed failure itself. */
const attemptError = (failure: AttemptFailure): Error =>
  Cause.isUnknownError(failure) ? rejectionError(failure) : failure;

const isMissingVariable = Schema.is(MissingVariable);
const isInitializeTimedOut = Schema.is(ExternalAgentInitializeTimedOut);

/**
 * Why a connection attempt failed, from what it rejected with. `detail` is not redacted yet: the
 * owner hides secrets before anyone sees it.
 */
const connectFailure = (error: Error) =>
  Match.value(error).pipe(
    Match.withReturnType<ShownFailure<ExternalAgentFailureCode>>(),
    Match.when(isMissingVariable, (missing) => ({ code: "missing_env", detail: missing.variable })),
    Match.when(isInitializeTimedOut, () => ({ code: "initialize_timed_out", detail: null })),
    Match.when(isPlatformError, (platform) => ({ code: "spawn_failed", detail: platform.message })),
    Match.when(Match.instanceOf(acp.RequestError), (request) => ({
      code: "agent_error",
      detail: failureText(request),
    })),
    Match.orElse((other) => ({ code: "connection_failed", detail: rejectionText(other) })),
  );

/** The option that allows exactly this once, or rejects; a standing "always" is never chosen. */
function permissionAnswer(
  request: RequestPermissionRequest,
  approved: boolean,
): RequestPermissionResponse {
  const wanted = approved ? "allow_once" : "reject_once";
  return Option.match(
    EffectArray.findFirst(request.options, (candidate) => candidate.kind === wanted),
    {
      onNone: () => ({ outcome: { outcome: "cancelled" } }),
      onSome: (option) => ({ outcome: { outcome: "selected", optionId: option.optionId } }),
    },
  );
}

/** A launcher Windows runs without cmd. */
const nativeLauncher = /\.(com|exe)$/i;

/** The interpreter and flags a `#!` line names, looking past `env` and its `-S`. */
const shebangOf = (firstLine: string) =>
  Option.flatMap(
    Option.liftPredicate(firstLine, (line) => line.startsWith("#!")),
    (line) => {
      const [interpreterPath = "", ...flags] = line.slice(2).trim().split(/\s+/);
      const named = interpreterPath.split("/").at(-1) ?? "";
      const [interpreter = "", ...rest] =
        named === "env" ? flags.slice(flags[0] === "-S" ? 1 : 0) : [named, ...flags];
      return Option.liftPredicate(
        { interpreter, flags: rest },
        (found) => found.interpreter.length > 0,
      );
    },
  );

/** Resolve Windows launchers using the same cmd metacharacter and npm shim escaping contract as cross-spawn. */
export const agentCommandInvocation = Effect.fn("ExternalAgent.commandInvocation")(
  function* (options: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
  }) {
    if ((options.platform ?? process.platform) !== "win32")
      return { command: options.command, args: [...options.args], shell: undefined };
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { cwd, env } = options;
    const extensions = ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")];
    const resolve = (name: string) =>
      Effect.findFirst(
        (/[\\/]/.test(name) ? [cwd] : [cwd, ...(env.Path ?? env.PATH ?? "").split(";")]).flatMap(
          (directory) =>
            extensions.map((extension) => path.resolve(cwd, directory, `${name}${extension}`)),
        ),
        // A candidate that cannot be inspected is not a launcher.
        (candidate) =>
          fs.stat(candidate).pipe(
            Effect.map((info) => info.type === "File"),
            Effect.catchTag("PlatformError", () => Effect.succeed(false)),
          ),
      );
    const found = yield* resolve(options.command);
    const direct = { command: options.command, args: options.args, executable: found };
    /** The script run by the interpreter its `#!` line names, or by itself without one. */
    const throughShebang = (script: string) =>
      fs.readFileString(script).pipe(
        // An unreadable launcher has no shebang to follow.
        Effect.catchTag("PlatformError", () => Effect.succeed("")),
        Effect.map((text) => shebangOf(text.split(/\r?\n/, 1)[0] ?? "")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(direct),
            onSome: ({ interpreter, flags }) =>
              Effect.map(resolve(interpreter), (executable) => ({
                command: interpreter,
                args: [...flags, script, ...options.args],
                executable,
              })),
          }),
        ),
      );
    const { command, args, executable } = yield* Option.match(
      Option.filter(found, (file) => !nativeLauncher.test(file)),
      { onNone: () => Effect.succeed(direct), onSome: throughShebang },
    );
    if (Option.exists(executable, (file) => nativeLauncher.test(file)))
      return { command, args: [...args], shell: undefined };
    // Anything else runs through cmd, which reads its metacharacters; an npm shim reads them twice.
    const meta = /([()\][%!^"`<>&|;, *?])/g;
    const doubleEscape = Option.exists(executable, (file) =>
      /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file),
    );
    const quote = (arg: string) => {
      const escaped =
        `"${arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, "$1$1")}"`.replace(
          meta,
          "^$1",
        );
      return doubleEscape ? escaped.replace(meta, "^$1") : escaped;
    };
    return {
      command: [path.normalize(command).replace(meta, "^$1"), ...args.map(quote)].join(" "),
      args: [],
      shell: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
    };
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
  const links = yield* SynchronizedRef.make(HashMap.empty<string, Link>());
  const retries = yield* FiberMap.make<string, void, never>();

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
    yield* retireLinks(
      (link, key) =>
        key.startsWith(`${project.id}/`) &&
        !Option.contains(MutableHashMap.get(usableFingerprints, key), link.fingerprint),
    );
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

  const close = (live: Live) =>
    Effect.andThen(
      Effect.sync(() => live.connection.close()),
      live.dispose,
    );

  /** Closes the process a link's state gave up, if it had one. */
  const closeTaken = (live: Live | null) =>
    Option.match(Option.fromNullishOr(live), { onNone: () => Effect.void, onSome: close });

  const shutdown = (link: Link) =>
    SynchronizedRef.modify(
      link.state,
      (state) => [state.live, { ...state, live: null }] as const,
    ).pipe(Effect.flatMap(closeTaken));

  const retire = (link: Link) =>
    SynchronizedRef.modify(
      link.state,
      (state) => [state.live, { ...state, retired: true, live: null }] as const,
    ).pipe(Effect.flatMap(closeTaken));

  /** Stops and forgets the links `stale` picks. */
  const retireLinks = (stale: (link: Link, key: string) => boolean) =>
    SynchronizedRef.modify(
      links,
      (current) =>
        [
          HashMap.values(HashMap.filter(current, stale)),
          HashMap.filter(current, (link, key) => !stale(link, key)),
        ] as const,
    ).pipe(Effect.flatMap((removed) => Effect.forEach(removed, retire, { discard: true })));

  const startProcess = (
    project: Project,
    agent: ConfiguredAgent,
    link: Link,
  ): Effect.Effect<Live, AttemptFailure> =>
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
      const dispose = Scope.close(owner, Exit.void);
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
        .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
          Option.match(MutableHashMap.get(handlers, ctx.params.sessionId), {
            onNone: () => Promise.resolve({ outcome: { outcome: "cancelled" } as const }),
            onSome: (handler) => handler.askPermission(ctx.params),
          }),
        )
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
            orElse: () => Effect.fail(ExternalAgentInitializeTimedOut.make()),
          }),
        );
        const live: Live = {
          dispose,
          connection,
          agentName: initialized.agentInfo?.name ?? null,
          loadSession: initialized.agentCapabilities?.loadSession === true,
          sessions: yield* Ref.make(HashMap.empty<string, string>()),
          handlers,
        };
        // Handled in its own fiber: handling it closes the process's scope these watchers run in.
        const lost = Effect.asVoid(Effect.forkIn(onLost(project, agent, link, live), serviceScope));
        yield* child.exitCode.pipe(
          Effect.onExit(() => lost),
          // Any end of the process is the lost connection handled above.
          Effect.catchTag("PlatformError", () => Effect.void),
          Effect.forkIn(owner),
        );
        yield* nativePromise(() => connection.closed).pipe(
          Effect.ignore,
          Effect.andThen(lost),
          Effect.forkIn(owner),
        );
        return live;
      }).pipe(
        Effect.onError(() =>
          Effect.andThen(
            Effect.sync(() => connection.close()),
            dispose,
          ),
        ),
      );
    });

  /** One connection attempt. Success clears the failure count; failure adds to it. */
  const connectOnce = (project: Project, agent: ConfiguredAgent, link: Link) =>
    startProcess(project, agent, link).pipe(
      Effect.matchEffect({
        onSuccess: (live) =>
          SynchronizedRef.modify(link.state, (state): readonly [boolean, LinkState] =>
            state.retired
              ? [true, { ...state, attempt: null }]
              : [
                  false,
                  {
                    ...state,
                    attempt: null,
                    live,
                    failures: 0,
                    shown: AgentLinkState.connected({
                      agent: live.agentName,
                      loadSession: live.loadSession,
                    }),
                  },
                ],
          ).pipe(
            Effect.flatMap((retired) => Effect.when(close(live), Effect.succeed(retired))),
            Effect.as(live),
          ),
        onFailure: (error) =>
          Effect.gen(function* () {
            const failures = yield* SynchronizedRef.modify(
              link.state,
              (state) =>
                [
                  state.failures + 1,
                  { ...state, attempt: null, failures: state.failures + 1 },
                ] as const,
            );
            const failure = yield* error.pipe(attemptError, connectFailure, redactor.hideDetail);
            // A newer attempt owns the state now.
            yield* SynchronizedRef.update(link.state, (state) =>
              state.attempt !== null
                ? state
                : {
                    ...state,
                    shown:
                      failures >= maxConsecutiveFailures
                        ? AgentLinkState.stopped({ failures, failure })
                        : AgentLinkState.retrying({ failures, failure }),
                  },
            );
            return yield* error;
          }),
      }),
    );

  /** The link's connection attempt, joining the one in flight. */
  const attempt = (project: Project, agent: ConfiguredAgent, link: Link) =>
    SynchronizedRef.modifyEffect(link.state, (state) =>
      state.attempt !== null
        ? Effect.succeed([state.attempt, state] as const)
        : Effect.map(
            // A caller that stops waiting does not stop the attempt the others share.
            Effect.forkIn(connectOnce(project, agent, link), serviceScope),
            (running) =>
              [
                running,
                {
                  ...state,
                  attempt: running,
                  shown: AgentLinkState.connecting({ failures: state.failures }),
                },
              ] as const,
          ),
    ).pipe(Effect.flatMap(Fiber.join));

  /**
   * A dropped connection is reconnected on its own until it fails twice in a row. Reconnecting
   * restores the connection only: nothing that was being asked is sent again.
   */
  const onLost = (project: Project, agent: ConfiguredAgent, link: Link, live: Live) => {
    const wanted = Effect.map(
      SynchronizedRef.get(link.state),
      (state) => !state.retired && state.live === null && state.failures < maxConsecutiveFailures,
    );
    // Each failed attempt counts, so `wanted` ends the retries; the link state reports the last one.
    const retry = Effect.sleep(retryDelayMs).pipe(
      Effect.andThen(Effect.when(attempt(project, agent, link), wanted)),
      Effect.retry({ while: () => wanted }),
      Effect.ignore,
    );
    const reconnect = Effect.andThen(
      live.dispose,
      FiberMap.run(retries, linkKey(project, agent), Effect.when(retry, wanted), {
        onlyIfMissing: true,
      }),
    );
    return SynchronizedRef.modify(link.state, (state) =>
      state.retired || state.live !== live
        ? ([false, state] as const)
        : ([true, { ...state, live: null }] as const),
    ).pipe(Effect.flatMap((current) => Effect.when(reconnect, Effect.succeed(current))));
  };

  const linkFor = Effect.fnUntraced(function* (project: Project, agent: ConfiguredAgent) {
    const key = linkKey(project, agent);
    const { link, replaced } = yield* SynchronizedRef.modifyEffect(links, (current) => {
      const existing = HashMap.get(current, key);
      return Option.match(
        Option.filter(existing, (link) => link.fingerprint === agent.fingerprint),
        {
          onSome: (link) =>
            Effect.succeed([{ link, replaced: Option.none<Link>() }, current] as const),
          onNone: () =>
            Effect.map(
              SynchronizedRef.make<LinkState>({
                retired: false,
                shown: AgentLinkState.idle(),
                live: null,
                attempt: null,
                failures: 0,
              }),
              (state) => {
                const link: Link = { fingerprint: agent.fingerprint, state };
                return [{ link, replaced: existing }, HashMap.set(current, key, link)] as const;
              },
            ),
        },
      );
    });
    // A changed configuration replaces the link the old one used.
    yield* Effect.transposeOption(Option.map(replaced, retire));
    return link;
  });

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
    const current = yield* SynchronizedRef.get(links);
    const views = yield* Effect.forEach(agents, (entry) =>
      Effect.map(
        Effect.all({
          // A command line can carry a key (`--api-key=…`); the page gets it hidden.
          target: redactor.shownDetail(
            [entry.agent.command.command, ...entry.agent.command.args].join(" "),
          ),
          link: Option.match(HashMap.get(current, linkKey(project, entry.agent)), {
            onNone: () => Effect.succeed<AgentLinkState>(AgentLinkState.idle()),
            onSome: (link) => Effect.map(SynchronizedRef.get(link.state), (state) => state.shown),
          }),
        }),
        ({ target, link }): ExternalAgentView => ({
          scope: entry.agent.scope,
          name: entry.agent.name,
          target,
          envNames: Object.keys(entry.agent.command.env),
          shadowed: entry.shadowed,
          state: Match.value(entry.trusted).pipe(
            Match.withReturnType<AgentTrustState>(),
            Match.when(Match.null, () => AgentTrustState.untrusted()),
            Match.when(
              (fingerprint) => fingerprint === entry.agent.fingerprint,
              () => AgentTrustState.trusted({ link }),
            ),
            Match.orElse(() => AgentTrustState.changed()),
          ),
        }),
      ),
    );
    return { files, agents: views };
  });

  yield* Effect.addFinalizer(() =>
    Effect.flatMap(SynchronizedRef.get(links), (current) =>
      Effect.forEach(HashMap.values(current), retire, { discard: true }),
    ),
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
        const entry = EffectArray.findFirst(
          (yield* configured(project)).agents,
          (candidate) => candidate.agent.scope === scope && candidate.agent.name === name,
        );
        const record = (agent: ConfiguredAgent) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) => {
            const trustedAt = DateTime.formatIso(DateTime.makeUnsafe(now));
            return sql`
              INSERT INTO agent_trust (scope, project_id, name, fingerprint, trusted_at)
              VALUES (${scope}, ${projectId}, ${name}, ${agent.fingerprint}, ${trustedAt})
              ON CONFLICT (scope, project_id, name) DO UPDATE
              SET fingerprint = excluded.fingerprint, trusted_at = excluded.trusted_at`;
          });
        const forget = sql`
          DELETE FROM agent_trust
          WHERE scope = ${scope} AND project_id = ${projectId} AND name = ${name}`.pipe(
          Effect.andThen(retireLinks((_, key) => key.endsWith(`/${scope}/${name}`))),
        );
        yield* trusted
          ? Option.match(entry, {
              onNone: () => Effect.void,
              onSome: (found) => record(found.agent),
            })
          : forget;
        return yield* overview(project);
      }),

    /** Manual reconnect: clears the failure count and tries once more. */
    reconnect: (project: Project, name: string) =>
      usable(project, name).pipe(
        Effect.flatMap((agent) =>
          Option.match(Option.fromNullishOr(agent), {
            onNone: () => Effect.void,
            onSome: (found) =>
              Effect.gen(function* () {
                const link = yield* linkFor(project, found);
                yield* shutdown(link);
                yield* SynchronizedRef.update(link.state, (state) => ({ ...state, failures: 0 }));
                // The attempt's failure is shown by the link state the overview reports.
                yield* Effect.ignore(attempt(project, found, link));
              }),
          }),
        ),
        Effect.andThen(overview(project)),
      ),

    /**
     * Sends one prompt to the agent in the conversation `sessionKey` (a new agent session the first
     * time, or after the process restarted) and waits for its answer. Interrupting it asks the
     * agent to stop the turn and waits for that answer, so the session is idle for its next prompt.
     */
    prompt: (
      project: Project,
      name: string,
      sessionKey: string,
      text: string,
      hooks: PromptHooks,
    ) => {
      // Aborted when the turn is interrupted; the turn's permission requests wait on it.
      const turn = new AbortController();
      return Effect.gen(function* () {
        const agent = yield* usable(project, name);
        if (!isTruthy(agent))
          return ExternalPromptOutcome.unavailable({
            failure: { code: "not_trusted", detail: null },
          });
        const link = yield* linkFor(project, agent);
        const state = yield* SynchronizedRef.get(link.state);
        if (
          state.failures >= maxConsecutiveFailures &&
          !isTruthy(state.live) &&
          !isTruthy(state.attempt)
        )
          return ExternalPromptOutcome.unavailable({
            failure: { code: "stopped_after_failures", detail: null },
          });
        const connected = yield* Effect.result(
          state.live === null ? attempt(project, agent, link) : Effect.succeed(state.live),
        );
        if (Result.isFailure(connected))
          return ExternalPromptOutcome.unavailable({
            failure: yield* connected.failure.pipe(
              attemptError,
              connectFailure,
              redactor.hideDetail,
            ),
          });
        const live = connected.success;

        let sessionId = Option.getOrUndefined(
          HashMap.get(yield* Ref.get(live.sessions), sessionKey),
        );
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
            return ExternalPromptOutcome.unavailable({
              failure: yield* redactor.hideDetail({
                code: "session_failed" as const,
                detail: rejectionText(error),
              }),
            });
          }
          sessionId = created.success.sessionId;
          yield* Ref.update(live.sessions, HashMap.set(sessionKey, sessionId));
        }

        let answer = "";
        const toolCalls = MutableHashMap.empty<string, ReportedToolCall>();
        MutableHashMap.set(live.handlers, sessionId, {
          onUpdate: (update) => {
            Match.value(update).pipe(
              Match.discriminators("sessionUpdate")({
                agent_message_chunk: (chunk) => {
                  answer += chunk.content.type === "text" ? chunk.content.text : "";
                },
                tool_call: (call) =>
                  MutableHashMap.set(toolCalls, call.toolCallId, {
                    title: call.title,
                    kind: call.kind ?? null,
                    status: call.status ?? null,
                  }),
                tool_call_update: (call) => {
                  const known = Option.getOrUndefined(
                    MutableHashMap.get(toolCalls, call.toolCallId),
                  );
                  MutableHashMap.set(toolCalls, call.toolCallId, {
                    title: call.title ?? known?.title ?? "",
                    kind: call.kind ?? known?.kind ?? null,
                    status: call.status ?? known?.status ?? null,
                  });
                },
              }),
              Match.orElse(EffectFunction.constVoid),
            );
            hooks.onUpdate?.(update);
          },
          // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
          askPermission: (request) =>
            runNativeEffect(
              Effect.map(hooks.askPermission(request, turn.signal), (answer) =>
                permissionAnswer(request, answer),
              ),
            ),
        });
        const agentSession = sessionId;
        const cancel = nativePromise(() =>
          live.connection.agent.notify(acp.methods.agent.session.cancel, {
            sessionId: agentSession,
          }),
        ).pipe(Effect.ignore);
        const answered = yield* Effect.forkChild(
          nativePromise(() =>
            live.connection.agent.request(acp.methods.agent.session.prompt, {
              sessionId: agentSession,
              prompt: [{ type: "text", text }],
            }),
          ),
          { startImmediately: true },
        );
        return yield* Fiber.join(answered).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => turn.abort()).pipe(
              Effect.andThen(cancel),
              Effect.andThen(Fiber.await(answered)),
            ),
          ),
          Effect.matchEffect({
            onSuccess: ({ stopReason }): Effect.Effect<ExternalPromptOutcome> => {
              const answered = {
                stopReason,
                answer,
                toolCalls: [...MutableHashMap.values(toolCalls)],
              };
              return Effect.succeed(
                stopReason === "cancelled"
                  ? ExternalPromptOutcome.cancelled(answered)
                  : ExternalPromptOutcome.completed(answered),
              );
            },
            onFailure: (failure): Effect.Effect<ExternalPromptOutcome> =>
              Effect.flatMap(
                SynchronizedRef.get(link.state),
                (current): Effect.Effect<ExternalPromptOutcome> =>
                  live.connection.signal.aborted || current.live !== live
                    ? Effect.succeed(
                        ExternalPromptOutcome.disconnected({
                          answer,
                          toolCalls: [...MutableHashMap.values(toolCalls)],
                        }),
                      )
                    : Effect.map(
                        redactor.hideDetail({
                          code: "agent_error" as const,
                          detail: failure.pipe(rejectionError, rejectionText),
                        }),
                        (shown) =>
                          ExternalPromptOutcome.failed({
                            failure: shown,
                            answer,
                            toolCalls: [...MutableHashMap.values(toolCalls)],
                          }),
                      ),
              ),
          }),
          Effect.ensuring(Effect.sync(() => MutableHashMap.remove(live.handlers, agentSession))),
        );
      });
    },
  };
});

/** External ACP agents the app calls as a client (R17): Codex and others. */
export class ExternalAgents extends Context.Service<ExternalAgents, Effect.Success<typeof make>>()(
  "memory-agent/external-agents/agents/ExternalAgents",
) {
  static readonly layer = Layer.effect(ExternalAgents, make);
}
