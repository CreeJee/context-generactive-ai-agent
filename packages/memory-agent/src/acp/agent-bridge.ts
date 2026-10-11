import { nativeFailure, nativePromise, runNativeEffect } from "../runtime/native-effect.ts";
import {
  Cause,
  Function,
  Result,
  MutableHashSet,
  HashMap,
  MutableHashMap,
  Effect,
  Fiber,
} from "effect";
import { isTruthy } from "../truthy.ts";
import { oauthProtocolCrypto } from "../oauth/node-runtime.ts";
import { oauthProtocolFileSystem } from "../oauth/node-runtime.ts";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentContext,
  ContentBlock,
  RequestPermissionResponse,
  SessionUpdate,
  StopReason,
  Stream,
} from "@agentclientprotocol/sdk";
import { ChatClient, fetchServerSentEvents, type UIMessage } from "@tanstack/ai-client";
import type { StreamChunk } from "@tanstack/ai";
import { sessionHolderHeader } from "../sessions/lease-state.ts";
import { Option, Schema } from "effect";
import {
  PermissionReviewPayload,
  approvalToolDefinitions,
  permissionReviewInterrupt,
} from "../tools/definitions.ts";
import { AppRequestFailed, type AppApi, type ProjectSummary } from "./app-api.ts";
import { toolDetail, toolLocations, toolView } from "./tool-view.ts";

/** How often a bridged session renews its lease; the app drops a lease after 90 seconds. */
const leaseRenewMs = 20_000;
/** How often a prompt checks for subagent and external agent calls waiting for approval. */
const relayPollMs = 1_500;
/** Longest tool output passed to the editor. */
const maxToolOutput = 4_000;

type Chat = ChatClient<typeof approvalToolDefinitions, [typeof permissionReviewInterrupt]>;

interface PromptTurn {
  readonly client: AgentContext;
  readonly args: MutableHashMap.MutableHashMap<string, string>;
  cancelled: boolean;
  failure: string | null;
}

interface BridgeSession {
  readonly id: string;
  /** This editor connection's lease holder, like a browser tab's. */
  readonly holder: string;
  readonly project: ProjectSummary;
  readonly chat: Chat;
  readonly renew: Fiber.Fiber<void>;
  turn: PromptTurn | null;
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

const explain = (error: Error) =>
  error instanceof acp.RequestError
    ? error
    : Schema.is(AppRequestFailed)(error)
      ? requestError(
          Option.getOrUndefined(HashMap.get(failureMessages, error.code)) ??
            `앱 요청이 실패했어요: ${error.code}`,
        )
      : requestError(error.message);

const decodeReview = Schema.decodeUnknownOption(
  Schema.Struct({ payload: PermissionReviewPayload }),
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

const requesterLabel = (
  requester:
    | { readonly kind: "subagent"; readonly name: string | null }
    | { readonly kind: "external_agent"; readonly agent: string },
) => {
  switch (requester.kind) {
    case "subagent":
      return isTruthy(requester.name) ? `서브에이전트 ${requester.name}` : "일회성 서브에이전트";
    case "external_agent":
      return `외부 에이전트 ${requester.agent}`;
  }
};

const cut = (text: string) =>
  text.length > maxToolOutput ? `${text.slice(0, maxToolOutput)}\n…` : text;

/** The agent side of ACP for editors such as Zed, backed by the running app (R17). */
export function startAcpAgent(options: {
  readonly stream: Stream;
  readonly api: AppApi;
}): acp.AgentConnection {
  const { api } = options;
  const sessions = MutableHashMap.empty<string, BridgeSession>();

  const notify = (turn: PromptTurn, sessionId: string, update: SessionUpdate) =>
    void turn.client.notify(acp.methods.client.session.update, { sessionId, update });

  /** Streams the app's run events to the editor as session updates. */
  const forward = (session: BridgeSession, chunk: StreamChunk) => {
    const turn = session.turn;
    if (!(turn !== null)) return;
    switch (chunk.type) {
      case "TEXT_MESSAGE_CONTENT":
        notify(turn, session.id, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: chunk.delta },
          messageId: chunk.messageId,
        });
        return;
      case "TOOL_CALL_START": {
        const view = toolView(chunk.toolCallName);
        MutableHashMap.set(turn.args, chunk.toolCallId, "");
        notify(turn, session.id, {
          sessionUpdate: "tool_call",
          toolCallId: chunk.toolCallId,
          title: view.title,
          kind: view.kind,
          status: "pending",
        });
        return;
      }
      case "TOOL_CALL_ARGS":
        MutableHashMap.set(
          turn.args,
          chunk.toolCallId,
          (Option.getOrUndefined(MutableHashMap.get(turn.args, chunk.toolCallId)) ?? "") +
            chunk.delta,
        );
        return;
      case "TOOL_CALL_END": {
        const args = Option.getOrUndefined(MutableHashMap.get(turn.args, chunk.toolCallId)) ?? "";
        const update: SessionUpdate = {
          sessionUpdate: "tool_call_update",
          toolCallId: chunk.toolCallId,
          status: "in_progress",
          locations: toolLocations(args, session.project.root),
          rawInput: args,
        };
        // The path, command or query makes a better title than the tool name alone.
        const detail = toolDetail(args);
        if (isTruthy(detail)) update.title = detail;
        notify(turn, session.id, update);
        return;
      }
      case "TOOL_CALL_RESULT":
        notify(turn, session.id, {
          sessionUpdate: "tool_call_update",
          toolCallId: chunk.toolCallId,
          status: "completed",
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: cut(
                  Schema.is(Schema.String)(chunk.content)
                    ? chunk.content
                    : stringifyJson(chunk.content),
                ),
              },
            },
          ],
        });
        return;
      case "RUN_ERROR":
        turn.failure = chunk.message;
        return;
      default:
        return;
    }
  };

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const open = Effect.fn("AcpAgent.open")(function* (
    sessionId: string,
    project: ProjectSummary,
    messages: UIMessage[],
  ) {
    const holder = `acp-${yield* oauthProtocolCrypto.randomUUIDv4().pipe(Effect.orDie)}`;
    const lease = yield* nativePromise(() => api.lease(sessionId, holder, "claim"));
    if (lease.state !== "mine")
      return yield* new Cause.UnknownError(
        AppRequestFailed.make({
          status: 423,
          code: "session_in_use",
          message: "session_in_use (423)",
          reason: { _tag: "RequestRejected" },
        }),
      );
    const renew = yield* Effect.forever(
      Effect.sleep(leaseRenewMs).pipe(
        Effect.andThen(nativePromise(() => api.lease(sessionId, holder, "claim"))),
        Effect.ignore,
      ),
    ).pipe(Effect.forkDetach);
    const session: BridgeSession = {
      id: sessionId,
      holder,
      project,
      renew,
      turn: null,
      chat: new ChatClient({
        tools: approvalToolDefinitions,
        interrupts: [permissionReviewInterrupt],
        initialMessages: messages,
        connection: fetchServerSentEvents(api.chatUrl(sessionId), {
          headers: { [sessionHolderHeader]: holder },
          fetchClient: api.fetcher,
        }),
        onChunk: (chunk) => forward(session, chunk),
      }),
    };
    MutableHashMap.set(sessions, sessionId, session);
    return session;
  });

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const projectFor = Effect.fn("AcpAgent.projectFor")(function* (cwd: string) {
    const root = yield* oauthProtocolFileSystem
      .realPath(cwd)
      .pipe(
        Effect.mapError(
          () => new Cause.UnknownError(requestError(`폴더를 찾을 수 없어요: ${cwd}`)),
        ),
      );
    const project = (yield* nativePromise(() => api.projects())).find(
      (candidate) => candidate.root === root,
    );
    // Registering a project widens what the file tools may touch, so only the app's page does it.
    if (!isTruthy(project))
      return yield* new Cause.UnknownError(
        requestError(`등록된 프로젝트가 아니에요. 앱에서 ${root}를 먼저 추가하세요.`),
      );
    return project;
  });

  // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
  const waitIdle = Effect.fn("AcpAgent.waitIdle")(function* (chat: Chat) {
    while (chat.getIsLoading()) yield* Effect.sleep(50);
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
  const relayApprovals = (session: BridgeSession, turn: PromptTurn) => {
    const asked = MutableHashSet.empty<string>();
    const timer = Effect.runFork(
      Effect.forever(
        Effect.sleep(relayPollMs).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const approvals = yield* nativePromise(() => api.approvals(session.id));
              yield* Effect.forEach(
                approvals,
                (approval) => {
                  if (MutableHashSet.has(asked, approval.id)) return Effect.void;
                  MutableHashSet.add(asked, approval.id);
                  return askEditor(turn, session.id, {
                    toolCallId: approval.id,
                    toolName: approval.toolName,
                    argumentsJson: approval.argumentsJson,
                    requester: requesterLabel(approval.requester),
                  }).pipe(
                    Effect.flatMap((approved) =>
                      nativePromise(() =>
                        api.answerApproval(session.id, session.holder, approval.id, approved),
                      ),
                    ),
                    Effect.ignore,
                  );
                },
                { concurrency: "unbounded", discard: true },
              );
            }),
          ),
          Effect.ignore,
        ),
      ),
    );
    return () => {
      void runNativeEffect(Fiber.interrupt(timer));
    };
  };

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
          const auth = yield* nativePromise(() => api.auth());
          if (auth.status !== "signed-in")
            return yield* new Cause.UnknownError(
              AppRequestFailed.make({
                status: 401,
                code: "login_required",
                message: "login_required (401)",
                reason: { _tag: "RequestRejected" },
              }),
            );
          const project = yield* projectFor(ctx.params.cwd);
          // MCP servers an editor offers are not trusted here; the app's own MCP settings apply.
          const created = yield* nativePromise(() => api.createSession(project.id, "ACP"));
          yield* open(created.id, project, []);
          return { sessionId: created.id };
        }).pipe(
          Effect.catchCause((cause) => {
            const error = nativeFailure(cause).cause;
            return Effect.fail(
              new Cause.UnknownError(
                explain(error instanceof Error ? error : new Error(String(error))),
              ),
            );
          }),
        ),
      ),
    )
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    .onRequest(acp.methods.agent.session.load, (ctx) =>
      runNativeEffect(
        Effect.gen(function* () {
          const project = yield* projectFor(ctx.params.cwd);
          const messages = yield* nativePromise(() => api.transcript(ctx.params.sessionId));
          const session =
            Option.getOrUndefined(MutableHashMap.get(sessions, ctx.params.sessionId)) ??
            (yield* open(ctx.params.sessionId, project, messages));
          // Replays the saved conversation, so the editor shows what the page shows.
          for (const message of messages)
            for (const part of message.parts)
              switch (part.type) {
                case "text":
                  yield* nativePromise(() =>
                    ctx.client.notify(acp.methods.client.session.update, {
                      sessionId: session.id,
                      update: {
                        sessionUpdate:
                          message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
                        content: { type: "text", text: part.content },
                        messageId: message.id,
                      },
                    }),
                  );
                  break;
                case "tool-call": {
                  const view = toolView(part.name);
                  yield* nativePromise(() =>
                    ctx.client.notify(acp.methods.client.session.update, {
                      sessionId: session.id,
                      update: {
                        sessionUpdate: "tool_call",
                        toolCallId: part.id,
                        title: toolDetail(part.arguments) ?? view.title,
                        kind: view.kind,
                        status: "completed",
                        rawInput: part.arguments,
                      },
                    }),
                  );
                  break;
                }
                default:
                  break;
              }
          return {};
        }).pipe(
          Effect.catchCause((cause) => {
            const error = nativeFailure(cause).cause;
            return Effect.fail(
              new Cause.UnknownError(
                explain(error instanceof Error ? error : new Error(String(error))),
              ),
            );
          }),
        ),
      ),
    )
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    .onRequest(acp.methods.agent.session.prompt, (ctx) =>
      runNativeEffect(
        Effect.gen(function* () {
          const session = Option.getOrUndefined(MutableHashMap.get(sessions, ctx.params.sessionId));
          if (!isTruthy(session))
            return yield* new Cause.UnknownError(
              requestError("그런 세션이 없어요. 새로 시작하거나 다시 불러오세요."),
            );
          if (isTruthy(session.turn))
            return yield* new Cause.UnknownError(requestError("이미 답하는 중이에요."));
          const turn: PromptTurn = {
            client: ctx.client,
            args: MutableHashMap.empty(),
            cancelled: false,
            failure: null,
          };
          session.turn = turn;
          const stopRelay = relayApprovals(session, turn);
          return yield* Effect.gen(function* () {
            yield* nativePromise(() => session.chat.sendMessage(promptText(ctx.params.prompt)));
            yield* waitIdle(session.chat);
            // Approvals: the run pauses; the editor answers each, and the run continues.
            for (;;) {
              const interrupts = session.chat.getInterrupts();
              if (interrupts.length === 0 || turn.cancelled) break;
              const answers = MutableHashMap.empty<string, boolean>();
              for (const interrupt of interrupts)
                switch (interrupt.kind) {
                  case "tool-approval":
                    MutableHashMap.set(
                      answers,
                      interrupt.id,
                      yield* askEditor(turn, session.id, {
                        toolCallId: interrupt.toolCallId,
                        toolName: interrupt.toolName,
                        argumentsJson: stringifyJson(interrupt.originalArgs),
                      }),
                    );
                    break;
                  case "generic": {
                    const review = Option.getOrUndefined(decodeReview(interrupt));
                    if (!(review !== undefined)) break;
                    MutableHashMap.set(
                      answers,
                      interrupt.id,
                      yield* askEditor(turn, session.id, {
                        toolCallId: review.payload.toolCallId,
                        toolName: review.payload.toolName,
                        argumentsJson: review.payload.arguments,
                      }),
                    );
                    break;
                  }
                  case "unbound":
                    break;
                }
              session.chat.resolveInterrupts((interrupt) => {
                const approved =
                  Option.getOrUndefined(MutableHashMap.get(answers, interrupt.id)) ?? false;
                switch (interrupt.kind) {
                  case "tool-approval":
                    interrupt.resolveInterrupt(approved);
                    break;
                  case "generic":
                    if (interrupt.binding.definitionId === permissionReviewInterrupt.id)
                      interrupt.resolveInterrupt({ approved });
                    break;
                }
                return undefined;
              });
              yield* Effect.sleep(50);
              yield* waitIdle(session.chat);
            }
            if (turn.cancelled) return { stopReason: "cancelled" as const satisfies StopReason };
            const failure = turn.failure ?? session.chat.getError()?.message ?? null;
            if (isTruthy(failure)) return yield* new Cause.UnknownError(requestError(failure));
            return { stopReason: "end_turn" as const satisfies StopReason };
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                stopRelay();
                session.turn = null;
              }),
            ),
          );
        }),
      ),
    )
    // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
    .onNotification(acp.methods.agent.session.cancel, (ctx) =>
      runNativeEffect(
        Effect.gen(function* () {
          const session = Option.getOrUndefined(MutableHashMap.get(sessions, ctx.params.sessionId));
          if (!isTruthy(session?.turn)) return;
          session.turn.cancelled = true;
          // The app's cancel stops the run for good; closing the stream alone would not (R10).
          yield* nativePromise(() => api.cancel(session.id, session.holder)).pipe(Effect.ignore);
        }),
      ),
    );

  const connection = app.connect(options.stream);
  void connection.closed.finally(() => {
    for (const session of MutableHashMap.values(sessions)) {
      void runNativeEffect(Fiber.interrupt(session.renew));
      void api.lease(session.id, session.holder, "release").catch(() => undefined);
    }
    MutableHashMap.clear(sessions);
  });
  return connection;
}
