import { nativePromise, runNativeEffect } from "../runtime/native-effect.ts";
import {
  Cause,
  Function,
  Result,
  HashMap,
  HashSet,
  Crypto,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Match,
  Ref,
  Stream,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { isTruthy } from "../truthy.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentContext,
  ContentBlock,
  RequestPermissionResponse,
  SessionUpdate,
  StopReason,
  Stream as AcpStream,
} from "@agentclientprotocol/sdk";
import { ApprovalRequester } from "../approvals/relayed-state.ts";
import { Option, Schema } from "effect";
import {
  ChatApi,
  type ChatMessage,
  maxPageSize,
  MessagePart,
  type PendingInterrupts,
  Refusal,
  refusalStatus,
  type ResumeEntry,
  type RunInput,
} from "../api/chat-api.ts";
import { AgUiEvent, RunOutcome } from "../loop/chunks.ts";
import {
  AppRequestFailed,
  AppRequestReason,
  AuthSummary,
  requestFailure,
  type AppApi,
  type ProjectSummary,
} from "./app-api.ts";
import { toolDetail, toolLocations, toolView } from "./tool-view.ts";
import { SecretRedactor } from "../secrets/redactor.ts";
import {
  RunFailureCode,
  runFailureCodeOf,
  runFailureText,
  type ShownFailure,
} from "../runtime/shown-failure.ts";
import { Schedule } from "effect";
import { LoopStep, superviseLoopStep } from "../runtime/loop-health.ts";

/** How often a bridged session renews its lease; the app drops a lease after 90 seconds. */
const leaseRenewMs = 20_000;
/** How often a prompt checks for subagent and external agent calls waiting for approval. */
const relayPollMs = 1_500;
/** Longest tool output passed to the editor. */
const maxToolOutput = 4_000;

interface PromptTurn {
  readonly client: AgentContext;
  readonly args: Ref.Ref<HashMap.HashMap<string, string>>;
  readonly cancelled: Ref.Ref<boolean>;
  readonly failure: Ref.Ref<Option.Option<ShownFailure<RunFailureCode>>>;
}

interface BridgeSession {
  readonly id: string;
  /** This editor connection's lease holder, like a browser tab's. */
  readonly holder: string;
  readonly project: ProjectSummary;
  readonly renew: Fiber.Fiber<void>;
  readonly turn: Ref.Ref<Option.Option<PromptTurn>>;
}

const stringifyJson = Function.flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);
const requestError = (message: string) => acp.RequestError.internalError(undefined, message);

const failureMessages = HashMap.fromIterable([
  ["unreachable", "앱에 연결하지 못했어요. context-generactive-agent 앱을 먼저 실행하세요."],
  ["login_required", "앱에서 ChatGPT에 로그인하세요."],
  ["model_selection_required", "앱에서 모델을 선택하세요."],
  ["session_in_use", "다른 창에서 쓰고 있는 대화예요."],
  ["session_not_found", "그런 대화가 없어요."],
]);

/** Why the bridge refused an editor's request itself, before or after asking the app. */
const EditorRefusal = Schema.TaggedUnion({
  FolderNotFound: { cwd: Schema.String },
  /** Registering a project widens what the file tools may touch, so only the page does it. */
  ProjectNotRegistered: { root: Schema.String },
  SessionNotOpen: {},
  TurnInProgress: {},
  /** The app's run ended with an error; `detail` is the run's own error text, redacted. */
  RunFailed: {
    code: RunFailureCode,
    detail: Schema.NullOr(Schema.String),
  },
});

class EditorRequestRefused extends Schema.TaggedError<EditorRequestRefused>()(
  "EditorRequestRefused",
  { reason: EditorRefusal },
) {}

const refusalMessage = EditorRefusal.match({
  FolderNotFound: ({ cwd }) => `폴더를 찾을 수 없어요: ${cwd}`,
  ProjectNotRegistered: ({ root }) =>
    `등록된 프로젝트가 아니에요. 앱에서 ${root}를 먼저 추가하세요.`,
  SessionNotOpen: () => "그런 세션이 없어요. 새로 시작하거나 다시 불러오세요.",
  TurnInProgress: () => "이미 답하는 중이에요.",
  RunFailed: ({ code }) => runFailureText[code],
});

/** A failed run as the editor receives it: the code's wording, and `{ code, detail }` as data. */
const runFailedError = (failure: ShownFailure<RunFailureCode>) =>
  acp.RequestError.internalError(
    { code: failure.code, detail: failure.detail },
    runFailureText[failure.code],
  );

/** The JSON-RPC error the editor receives. */
const explain = (
  redactor: SecretRedactor["Service"],
  error: Error,
): Effect.Effect<acp.RequestError> =>
  error instanceof acp.RequestError
    ? Effect.succeed(error)
    : Schema.is(AppRequestFailed)(error)
      ? Effect.succeed(
          requestError(
            Option.getOrUndefined(HashMap.get(failureMessages, error.code)) ??
              `앱 요청이 실패했어요: ${error.code}`,
          ),
        )
      : Schema.is(EditorRequestRefused)(error)
        ? Effect.succeed(
            EditorRefusal.matchOrElse(error.reason, { RunFailed: runFailedError }, (reason) =>
              requestError(refusalMessage(reason)),
            ),
          )
        : // Anything else can quote a URL or a credential; its text goes out redacted.
          Effect.map(redactor.shownDetail(error.message), (detail) =>
            runFailedError({ code: "run_failed", detail }),
          );

/** Unwraps a rejected app call and fails with the editor's error for it. */
const toEditorError = (redactor: SecretRedactor["Service"]) => (failure: Error) => {
  // Promise callbacks reject with values of any kind.
  const error = Cause.isUnknownError(failure) ? failure.cause : failure;
  return Effect.flatMap(
    explain(redactor, error instanceof Error ? error : new Error(String(error))),
    Effect.fail,
  );
};

const isRefusal = Schema.is(Refusal);
const isCoded = Schema.is(Schema.Struct({ error: Schema.String }));

/** A failed chat API call as the app's error: its refusal code, or an app that was not reached. */
const appFailure = Match.type<unknown>().pipe(
  Match.when(isRefusal, (refusal) =>
    requestFailure({
      status: refusalStatus(refusal),
      code: refusal.error,
      reason: "RequestRejected",
    }),
  ),
  // A cross-site refusal, or a run log the app could not read.
  Match.when(isCoded, ({ error }) =>
    requestFailure({ status: 0, code: error, reason: "RequestRejected" }),
  ),
  Match.orElse(() => requestFailure({ status: 0, code: "unreachable", reason: "TransportFailed" })),
);

/** The approvals a run's last event says it waits for. */
const waitingFor = (event: AgUiEvent): Result.Result<PendingInterrupts, AgUiEvent> =>
  AgUiEvent.guards.RUN_FINISHED(event) &&
  event.outcome !== undefined &&
  RunOutcome.guards.interrupt(event.outcome)
    ? Result.succeed({ runId: event.runId, pending: event.outcome.interrupts })
    : Result.fail(event);

/** The call an approval asks about, as the editor shows it. */
const askedCall = Match.type<PendingInterrupts["pending"][number]>().pipe(
  Match.discriminatorsExhaustive("reason")({
    tool_call: ({ toolCallId, metadata }) => ({
      toolCallId,
      toolName: metadata.toolName,
      argumentsJson: stringifyJson(metadata.input),
    }),
    permission_review: ({ metadata: { payload } }) => ({
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      argumentsJson: payload.arguments,
    }),
  }),
);
const decodeTextResource = Schema.decodeUnknownOption(
  Schema.Struct({ uri: Schema.String, text: Schema.String }),
);

/** Editor prompt blocks as one user message. Resources are inlined with their URI. */
function promptText(blocks: readonly ContentBlock[]) {
  return blocks
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text;
        case "resource_link":
          return `[${block.name}](${block.uri})`;
        case "resource":
          return Option.match(decodeTextResource(block.resource), {
            onNone: () => `[resource ${block.resource.uri}]`,
            onSome: (resource) =>
              `\n<resource uri="${resource.uri}">\n${resource.text}\n</resource>\n`,
          });
        case "image":
        case "audio":
          return "";
      }
    })
    .join("");
}

const requesterLabel = ApprovalRequester.match({
  subagent: ({ name }) => (isTruthy(name) ? `서브에이전트 ${name}` : "일회성 서브에이전트"),
  external_agent: ({ agent }) => `외부 에이전트 ${agent}`,
});

const cut = (text: string) =>
  text.length > maxToolOutput ? `${text.slice(0, maxToolOutput)}\n…` : text;

/** What the editor shows of a saved message's part; nothing for the parts it does not show. */
const replayed = (message: ChatMessage) =>
  MessagePart.matchOrElse(
    {
      text: ({ content }): ReadonlyArray<SessionUpdate> => [
        {
          sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
          content: { type: "text", text: content },
          messageId: message.id,
        },
      ],
      "tool-call": (call): ReadonlyArray<SessionUpdate> => {
        const view = toolView(call.name);
        return [
          {
            sessionUpdate: "tool_call",
            toolCallId: call.id,
            title: toolDetail(call.arguments) ?? view.title,
            kind: view.kind,
            status: "completed",
            rawInput: call.arguments,
          },
        ];
      },
    },
    (): ReadonlyArray<SessionUpdate> => [],
  );

const makeAcpAgent = Effect.fnUntraced(function* (options: {
  readonly stream: AcpStream;
  readonly api: AppApi;
}) {
  const { api } = options;
  const redactor = yield* SecretRedactor;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const editorError = toEditorError(redactor);
  const sessions = yield* Ref.make(HashMap.empty<string, BridgeSession>());
  const sessionOf = (sessionId: string) => Effect.map(Ref.get(sessions), HashMap.get(sessionId));

  // The SDK sends the notification on its own; the run does not wait for it.
  const notify = (turn: PromptTurn, sessionId: string, update: SessionUpdate) =>
    Effect.sync(
      () => void turn.client.notify(acp.methods.client.session.update, { sessionId, update }),
    );
  const argsOf = (turn: PromptTurn, toolCallId: string) =>
    Effect.map(Ref.get(turn.args), (args) =>
      Option.getOrElse(HashMap.get(args, toolCallId), () => ""),
    );

  /** Streams the app's run events to the editor as session updates. */
  const forward = (session: BridgeSession, turn: PromptTurn) =>
    AgUiEvent.matchOrElse(
      {
        TEXT_MESSAGE_CONTENT: ({ delta, messageId }) =>
          notify(turn, session.id, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: delta },
            messageId,
          }),
        TOOL_CALL_START: ({ toolCallId, toolCallName }) => {
          const view = toolView(toolCallName);
          return Ref.update(turn.args, HashMap.set(toolCallId, "")).pipe(
            Effect.andThen(
              notify(turn, session.id, {
                sessionUpdate: "tool_call",
                toolCallId,
                title: view.title,
                kind: view.kind,
                status: "pending",
              }),
            ),
          );
        },
        TOOL_CALL_ARGS: ({ toolCallId, delta }) =>
          Ref.update(turn.args, (args) =>
            HashMap.set(
              args,
              toolCallId,
              Option.getOrElse(HashMap.get(args, toolCallId), () => "") + delta,
            ),
          ),
        TOOL_CALL_END: ({ toolCallId }) =>
          Effect.flatMap(argsOf(turn, toolCallId), (args) => {
            const update: SessionUpdate = {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: "in_progress",
              locations: toolLocations(args, session.project.root),
              rawInput: args,
            };
            // The path, command or query makes a better title than the tool name alone.
            const detail = toolDetail(args);
            if (isTruthy(detail)) update.title = detail;
            return notify(turn, session.id, update);
          }),
        TOOL_CALL_RESULT: ({ toolCallId, content }) =>
          notify(turn, session.id, {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: cut(content) } }],
          }),
        // The app hid secrets in the message before sending it.
        RUN_ERROR: ({ code, message }) =>
          Ref.set(turn.failure, Option.some({ code: runFailureCodeOf(code), detail: message })),
      },
      () => Effect.void,
    );

  /** The app's chat API. Its calls go through the bridge's fetch (`withAppFetch`). */
  const { chat } = yield* HttpApiClient.make(ChatApi, { baseUrl: api.baseUrl });
  const withAppFetch = Effect.provideService(FetchHttpClient.Fetch, api.fetcher);

  /** Starts one run of a turn and forwards its events; the approvals it ends waiting for. */
  const runOnce = Effect.fn("AcpAgent.runOnce")(
    function* (session: BridgeSession, turn: PromptTurn, input: Omit<RunInput, "runId">) {
      const events = yield* chat.run({
        params: { session: session.id },
        headers: { "x-session-holder": session.holder },
        payload: { runId: yield* crypto.randomUUIDv7(), ...input },
      });
      return yield* events.pipe(
        Stream.map(({ data }) => data),
        Stream.tap(forward(session, turn)),
        Stream.filterMap(waitingFor),
        Stream.runLast,
      );
    },
    withAppFetch,
    Effect.mapError(appFailure),
  );

  /**
   * Asks the editor about every approval the run waits for, one at a time, and answers them with
   * the run that resumes it, until a run ends without waiting or the turn is cancelled.
   */
  const answered = (
    session: BridgeSession,
    turn: PromptTurn,
    waiting: Option.Option<PendingInterrupts>,
  ): Effect.Effect<void, AppRequestFailed | Cause.UnknownError> =>
    Effect.flatMap(Ref.get(turn.cancelled), (cancelled) =>
      Option.match(
        Option.filter(waiting, () => !cancelled),
        {
          onNone: () => Effect.void,
          onSome: ({ runId, pending }) =>
            Effect.forEach(pending, (interrupt) =>
              Effect.map(
                askEditor(turn, session.id, askedCall(interrupt)),
                (approved): ResumeEntry => ({
                  interruptId: interrupt.id,
                  status: "resolved",
                  payload: { approved },
                }),
              ),
            ).pipe(
              Effect.flatMap((resume) =>
                runOnce(session, turn, { parentRunId: runId, messages: [], resume }),
              ),
              Effect.flatMap((next) => answered(session, turn, next)),
            ),
        },
      ),
    );

  const open = Effect.fn("AcpAgent.open")(function* (sessionId: string, project: ProjectSummary) {
    const holder = `acp-${yield* crypto.randomUUIDv4()}`;
    const lease = yield* api.lease(sessionId, holder, "claim");
    if (lease.state !== "mine")
      return yield* AppRequestFailed.make({
        status: 423,
        code: "session_in_use",
        message: "session_in_use (423)",
        reason: AppRequestReason.cases.RequestRejected.make({}),
      });
    // A failed renewal is retried with backoff. When the retries run out, or on a defect, renewal
    // stops: the app drops the lease and shows the session read-only (decided 2026-10-18).
    const renew = yield* api.lease(sessionId, holder, "claim").pipe(
      superviseLoopStep({ message: "acp_lease_renewal_stopped", setHealth: () => Effect.void }),
      Effect.repeat({
        schedule: Schedule.spaced(leaseRenewMs),
        while: LoopStep.$is("Continued"),
      }),
      Effect.delay(leaseRenewMs),
      Effect.asVoid,
      Effect.forkDetach,
    );
    const session: BridgeSession = {
      id: sessionId,
      holder,
      project,
      renew,
      turn: yield* Ref.make(Option.none<PromptTurn>()),
    };
    yield* Ref.update(sessions, HashMap.set(sessionId, session));
    return session;
  });

  const projectFor = Effect.fn("AcpAgent.projectFor")(function* (cwd: string) {
    const root = yield* fileSystem
      .realPath(cwd)
      .pipe(
        Effect.mapError(() =>
          EditorRequestRefused.make({ reason: EditorRefusal.cases.FolderNotFound.make({ cwd }) }),
        ),
      );
    const project = (yield* api.projects).find((candidate) => candidate.root === root);
    // Registering a project widens what the file tools may touch, so only the app's page does it.
    if (!isTruthy(project))
      return yield* EditorRequestRefused.make({
        reason: EditorRefusal.cases.ProjectNotRegistered.make({ root }),
      });
    return project;
  });

  /** Asks the editor about one call; anything but an explicit allow is a no. */
  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const askEditor = Effect.fn("AcpAgent.askEditor")(function* (
    turn: PromptTurn,
    sessionId: string,
    call: { toolCallId: string; toolName: string; argumentsJson: string; requester?: string },
  ) {
    const view = toolView(call.toolName);
    const response: RequestPermissionResponse = yield* nativePromise(() =>
      turn.client.request(acp.methods.client.session.requestPermission, {
        sessionId,
        toolCall: {
          toolCallId: call.toolCallId,
          title: isTruthy(call.requester) ? `${call.requester}: ${view.title}` : view.title,
          kind: view.kind,
          status: "pending",
          rawInput: call.argumentsJson,
        },
        options: [
          { optionId: "allow", name: "이번 한 번 허용", kind: "allow_once" },
          { optionId: "reject", name: "거부", kind: "reject_once" },
        ],
      }),
    );
    return response.outcome.outcome === "selected" && response.outcome.optionId === "allow";
  });

  /** Relays calls of subagents and external agents that wait for approval, while the turn runs. */
  const relayApprovals = Effect.fnUntraced(function* (session: BridgeSession, turn: PromptTurn) {
    const asked = yield* Ref.make(HashSet.empty<string>());
    return yield* Effect.gen(function* () {
      const approvals = yield* api.approvals(session.id);
      yield* Effect.forEach(
        approvals,
        (approval) =>
          askEditor(turn, session.id, {
            toolCallId: approval.id,
            toolName: approval.toolName,
            argumentsJson: approval.argumentsJson,
            requester: requesterLabel(approval.requester),
          }).pipe(
            Effect.flatMap((approved) =>
              api.answerApproval(session.id, session.holder, approval.id, approved),
            ),
            // An unanswered approval stays pending in the app, where the page can answer it.
            Effect.catchTag(["UnknownError", "AppRequestFailed"], () => Effect.void),
            Effect.when(
              Ref.modify(asked, (seen) => [
                !HashSet.has(seen, approval.id),
                HashSet.add(seen, approval.id),
              ]),
            ),
          ),
        { concurrency: "unbounded", discard: true },
      );
    }).pipe(
      // A failed poll is retried with backoff. When the retries run out, or on a defect, relaying
      // stops for this turn; the waiting approvals stay answerable in the app (decided 2026-10-18).
      superviseLoopStep({ message: "acp_approval_relay_stopped", setHealth: () => Effect.void }),
      Effect.repeat({
        schedule: Schedule.spaced(relayPollMs),
        while: LoopStep.$is("Continued"),
      }),
      Effect.delay(relayPollMs),
    );
  });

  const app = acp
    .agent({ name: "context-generactive-agent" })
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    .onRequest(acp.methods.agent.initialize, () =>
      Promise.resolve({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
        },
        agentInfo: { name: "context-generactive-agent", version: "0.0.0" },
        authMethods: [],
      }),
    )
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    .onRequest(acp.methods.agent.authenticate, () => Promise.resolve({}))
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    .onRequest(acp.methods.agent.session.new, (ctx) =>
      runNativeEffect(
        Effect.gen(function* () {
          const auth = yield* api.auth;
          if (!AuthSummary.guards["signed-in"](auth))
            return yield* AppRequestFailed.make({
              status: 401,
              code: "login_required",
              message: "login_required (401)",
              reason: AppRequestReason.cases.RequestRejected.make({}),
            });
          const project = yield* projectFor(ctx.params.cwd);
          // MCP servers an editor offers are not trusted here; the app's own MCP settings apply.
          const created = yield* api.createSession(project.id, "ACP");
          yield* open(created.id, project);
          return { sessionId: created.id };
        }).pipe(Effect.catch(editorError)),
      ),
    )
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    .onRequest(acp.methods.agent.session.load, (ctx) =>
      runNativeEffect(
        Effect.gen(function* () {
          const project = yield* projectFor(ctx.params.cwd);
          const { messages } = yield* chat
            .snapshot({ params: { session: ctx.params.sessionId }, query: { limit: maxPageSize } })
            .pipe(withAppFetch, Effect.mapError(appFailure));
          const session = yield* Effect.flatMap(
            sessionOf(ctx.params.sessionId),
            Option.match({
              onNone: () => open(ctx.params.sessionId, project),
              onSome: Effect.succeed,
            }),
          );
          // Replays the saved conversation, so the editor shows what the page shows.
          yield* Effect.forEach(
            messages.flatMap((message) => message.parts.flatMap(replayed(message))),
            (update) =>
              nativePromise(() =>
                ctx.client.notify(acp.methods.client.session.update, {
                  sessionId: session.id,
                  update,
                }),
              ),
            { discard: true },
          );
          return {};
        }).pipe(Effect.catch(editorError)),
      ),
    )
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    .onRequest(acp.methods.agent.session.prompt, (ctx) =>
      runNativeEffect(
        Effect.gen(function* () {
          const session = Option.getOrUndefined(yield* sessionOf(ctx.params.sessionId));
          if (!isTruthy(session))
            return yield* EditorRequestRefused.make({
              reason: EditorRefusal.cases.SessionNotOpen.make({}),
            });
          const turn: PromptTurn = {
            client: ctx.client,
            args: yield* Ref.make(HashMap.empty<string, string>()),
            cancelled: yield* Ref.make(false),
            failure: yield* Ref.make(Option.none<ShownFailure<RunFailureCode>>()),
          };
          // Checked and taken in one Ref.modify, so two prompts never share a session's turn.
          const claimed = yield* Ref.modify(session.turn, (current) =>
            Option.isSome(current) ? [false, current] : [true, Option.some(turn)],
          );
          if (!claimed)
            return yield* EditorRequestRefused.make({
              reason: EditorRefusal.cases.TurnInProgress.make({}),
            });
          const relay = yield* Effect.forkChild(relayApprovals(session, turn));
          return yield* Effect.gen(function* () {
            yield* runOnce(session, turn, {
              messages: [
                {
                  id: yield* crypto.randomUUIDv7(),
                  role: "user",
                  content: promptText(ctx.params.prompt),
                },
              ],
            }).pipe(
              // Approvals: the run pauses; the editor answers each, and the run continues.
              Effect.flatMap((waiting) => answered(session, turn, waiting)),
              // A cancelled run's stream may end any way; the turn ends as cancelled.
              Effect.catch((error) =>
                Effect.fail(error).pipe(
                  Effect.when(Effect.map(Ref.get(turn.cancelled), (cancelled) => !cancelled)),
                ),
              ),
            );
            if (yield* Ref.get(turn.cancelled))
              return { stopReason: "cancelled" as const satisfies StopReason };
            const failure = yield* Ref.get(turn.failure);
            if (Option.isSome(failure))
              return yield* EditorRequestRefused.make({
                reason: EditorRefusal.cases.RunFailed.make(failure.value),
              });
            return { stopReason: "end_turn" as const satisfies StopReason };
          }).pipe(
            Effect.ensuring(
              Fiber.interrupt(relay).pipe(Effect.andThen(Ref.set(session.turn, Option.none()))),
            ),
          );
        }).pipe(Effect.catch(editorError)),
      ),
    )
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    .onNotification(acp.methods.agent.session.cancel, (ctx) =>
      runNativeEffect(
        Effect.gen(function* () {
          const session = Option.getOrUndefined(yield* sessionOf(ctx.params.sessionId));
          if (!isTruthy(session)) return;
          const turn = Option.getOrUndefined(yield* Ref.get(session.turn));
          if (!isTruthy(turn)) return;
          yield* Ref.set(turn.cancelled, true);
          // The app's cancel stops the run for good; closing the stream alone would not (R10).
          yield* api.cancel(session.id, session.holder).pipe(
            // The turn is already marked cancelled; a failed app cancel is only logged.
            Effect.catchTag("AppRequestFailed", () =>
              Effect.logWarning("ACP cancel request failed", { error: "AppRequestFailed" }),
            ),
          );
        }),
      ),
    );

  const connection = app.connect(options.stream);
  void connection.closed.finally(() =>
    runNativeEffect(
      Effect.flatMap(Ref.getAndSet(sessions, HashMap.empty()), (closed) =>
        Effect.forEach(
          HashMap.values(closed),
          (session) =>
            Effect.all(
              [
                Fiber.interrupt(session.renew),
                Effect.ignore(api.lease(session.id, session.holder, "release")),
              ],
              { concurrency: "unbounded", discard: true },
            ),
          { concurrency: "unbounded", discard: true },
        ),
      ),
    ),
  );
  return connection;
});

/** The agent side of ACP for editors such as Zed, backed by the running app (R17). */
export const startAcpAgent = (options: { readonly stream: AcpStream; readonly api: AppApi }) =>
  // The bridge runs in its own process, outside the app's services.
  Effect.scoped(
    Effect.flatMap(
      Layer.build(
        Layer.mergeAll(
          SecretRedactor.layer,
          FetchHttpClient.layer,
          NodeCrypto.layer,
          NodeFileSystem.layer,
        ),
      ),
      (services) => Effect.provideContext(makeAcpAgent(options), services),
    ),
  );
