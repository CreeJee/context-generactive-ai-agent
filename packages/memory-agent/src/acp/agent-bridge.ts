import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
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
  readonly args: Map<string, string>;
  cancelled: boolean;
  failure: string | null;
}

interface BridgeSession {
  readonly id: string;
  /** This editor connection's lease holder, like a browser tab's. */
  readonly holder: string;
  readonly project: ProjectSummary;
  readonly chat: Chat;
  readonly renew: NodeJS.Timeout;
  turn: PromptTurn | null;
}

const requestError = (message: string) => acp.RequestError.internalError(undefined, message);

const failureMessages = new Map([
  ["unreachable", "앱에 연결하지 못했어요. context-generactive-agent 앱을 먼저 실행하세요."],
  ["login_required", "앱에서 ChatGPT에 로그인하세요."],
  ["model_selection_required", "앱에서 모델을 선택하세요."],
  ["session_in_use", "다른 창에서 쓰고 있는 대화예요."],
  ["session_not_found", "그런 대화가 없어요."],
]);

const explain = (error: Error) =>
  error instanceof acp.RequestError
    ? error
    : error instanceof AppRequestFailed
      ? requestError(failureMessages.get(error.code) ?? `앱 요청이 실패했어요: ${error.code}`)
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
      return requester.name ? `서브에이전트 ${requester.name}` : "일회성 서브에이전트";
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
  const sessions = new Map<string, BridgeSession>();

  const notify = (turn: PromptTurn, sessionId: string, update: SessionUpdate) =>
    void turn.client.notify(acp.methods.client.session.update, { sessionId, update });

  /** Streams the app's run events to the editor as session updates. */
  const forward = (session: BridgeSession, chunk: StreamChunk) => {
    const turn = session.turn;
    if (!turn) return;
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
        turn.args.set(chunk.toolCallId, "");
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
        turn.args.set(chunk.toolCallId, (turn.args.get(chunk.toolCallId) ?? "") + chunk.delta);
        return;
      case "TOOL_CALL_END": {
        const args = turn.args.get(chunk.toolCallId) ?? "";
        const update: SessionUpdate = {
          sessionUpdate: "tool_call_update",
          toolCallId: chunk.toolCallId,
          status: "in_progress",
          locations: toolLocations(args, session.project.root),
          rawInput: args,
        };
        // The path, command or query makes a better title than the tool name alone.
        const detail = toolDetail(args);
        if (detail) update.title = detail;
        notify(turn, session.id, update);
        return;
      }
      case "TOOL_CALL_RESULT":
        notify(turn, session.id, {
          sessionUpdate: "tool_call_update",
          toolCallId: chunk.toolCallId,
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: cut(chunk.content) } }],
        });
        return;
      case "RUN_ERROR":
        turn.failure = chunk.message;
        return;
      default:
        return;
    }
  };

  const open = async (sessionId: string, project: ProjectSummary, messages: UIMessage[]) => {
    const holder = `acp-${randomUUID()}`;
    const lease = await api.lease(sessionId, holder, "claim");
    if (lease.state !== "mine") throw new AppRequestFailed(423, "session_in_use");
    const renew = setInterval(
      () => void api.lease(sessionId, holder, "claim").catch(() => undefined),
      leaseRenewMs,
    );
    renew.unref();
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
    sessions.set(sessionId, session);
    return session;
  };

  const projectFor = async (cwd: string) => {
    let root: string;
    try {
      root = realpathSync(cwd);
    } catch {
      throw requestError(`폴더를 찾을 수 없어요: ${cwd}`);
    }
    const project = (await api.projects()).find((candidate) => candidate.root === root);
    // Registering a project widens what the file tools may touch, so only the app's page does it.
    if (!project)
      throw requestError(`등록된 프로젝트가 아니에요. 앱에서 ${root}를 먼저 추가하세요.`);
    return project;
  };

  const waitIdle = async (chat: Chat) => {
    while (chat.getIsLoading()) await new Promise((resolve) => setTimeout(resolve, 50));
  };

  /** Asks the editor about one call; anything but an explicit allow is a no. */
  const askEditor = async (
    turn: PromptTurn,
    sessionId: string,
    call: { toolCallId: string; toolName: string; argumentsJson: string; requester?: string },
  ) => {
    const view = toolView(call.toolName);
    const response: RequestPermissionResponse = await turn.client.request(
      acp.methods.client.session.requestPermission,
      {
        sessionId,
        toolCall: {
          toolCallId: call.toolCallId,
          title: call.requester ? `${call.requester}: ${view.title}` : view.title,
          kind: view.kind,
          status: "pending",
          rawInput: call.argumentsJson,
        },
        options: [
          { optionId: "allow", name: "이번 한 번 허용", kind: "allow_once" },
          { optionId: "reject", name: "거부", kind: "reject_once" },
        ],
      },
    );
    return response.outcome.outcome === "selected" && response.outcome.optionId === "allow";
  };

  /** Relays calls of subagents and external agents that wait for approval, while the turn runs. */
  const relayApprovals = (session: BridgeSession, turn: PromptTurn) => {
    const asked = new Set<string>();
    const timer = setInterval(() => {
      void api
        .approvals(session.id)
        .then((approvals) => {
          for (const approval of approvals) {
            if (asked.has(approval.id)) continue;
            asked.add(approval.id);
            void askEditor(turn, session.id, {
              toolCallId: approval.id,
              toolName: approval.toolName,
              argumentsJson: approval.argumentsJson,
              requester: requesterLabel(approval.requester),
            })
              .then((approved) =>
                api.answerApproval(session.id, session.holder, approval.id, approved),
              )
              .catch(() => undefined);
          }
        })
        .catch(() => undefined);
    }, relayPollMs);
    return () => clearInterval(timer);
  };

  const app = acp
    .agent({ name: "context-generactive-agent" })
    .onRequest(acp.methods.agent.initialize, async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
      },
      agentInfo: { name: "context-generactive-agent", version: "0.0.0" },
      authMethods: [],
    }))
    .onRequest(acp.methods.agent.authenticate, async () => ({}))
    .onRequest(acp.methods.agent.session.new, async (ctx) => {
      try {
        const auth = await api.auth();
        if (auth.status !== "signed-in") throw new AppRequestFailed(401, "login_required");
        const project = await projectFor(ctx.params.cwd);
        // MCP servers an editor offers are not trusted here; the app's own MCP settings apply.
        const created = await api.createSession(project.id, "ACP");
        await open(created.id, project, []);
        return { sessionId: created.id };
      } catch (error) {
        throw explain(error instanceof Error ? error : new Error(String(error)));
      }
    })
    .onRequest(acp.methods.agent.session.load, async (ctx) => {
      try {
        const project = await projectFor(ctx.params.cwd);
        const messages = await api.transcript(ctx.params.sessionId);
        const session =
          sessions.get(ctx.params.sessionId) ??
          (await open(ctx.params.sessionId, project, messages));
        // Replays the saved conversation, so the editor shows what the page shows.
        for (const message of messages)
          for (const part of message.parts)
            switch (part.type) {
              case "text":
                await ctx.client.notify(acp.methods.client.session.update, {
                  sessionId: session.id,
                  update: {
                    sessionUpdate:
                      message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
                    content: { type: "text", text: part.content },
                    messageId: message.id,
                  },
                });
                break;
              case "tool-call": {
                const view = toolView(part.name);
                await ctx.client.notify(acp.methods.client.session.update, {
                  sessionId: session.id,
                  update: {
                    sessionUpdate: "tool_call",
                    toolCallId: part.id,
                    title: toolDetail(part.arguments) ?? view.title,
                    kind: view.kind,
                    status: "completed",
                    rawInput: part.arguments,
                  },
                });
                break;
              }
              default:
                break;
            }
        return {};
      } catch (error) {
        throw explain(error instanceof Error ? error : new Error(String(error)));
      }
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session) throw requestError("그런 세션이 없어요. 새로 시작하거나 다시 불러오세요.");
      if (session.turn) throw requestError("이미 답하는 중이에요.");
      const turn: PromptTurn = {
        client: ctx.client,
        args: new Map(),
        cancelled: false,
        failure: null,
      };
      session.turn = turn;
      const stopRelay = relayApprovals(session, turn);
      try {
        await session.chat.sendMessage(promptText(ctx.params.prompt));
        await waitIdle(session.chat);
        // Approvals: the run pauses; the editor answers each, and the run continues.
        for (;;) {
          const interrupts = session.chat.getInterrupts();
          if (interrupts.length === 0 || turn.cancelled) break;
          const answers = new Map<string, boolean>();
          for (const interrupt of interrupts)
            switch (interrupt.kind) {
              case "tool-approval":
                answers.set(
                  interrupt.id,
                  await askEditor(turn, session.id, {
                    toolCallId: interrupt.toolCallId,
                    toolName: interrupt.toolName,
                    argumentsJson: JSON.stringify(interrupt.originalArgs),
                  }),
                );
                break;
              case "generic": {
                const review = Option.getOrUndefined(decodeReview(interrupt));
                if (!review) break;
                answers.set(
                  interrupt.id,
                  await askEditor(turn, session.id, {
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
            const approved = answers.get(interrupt.id) ?? false;
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
          await new Promise((resolve) => setTimeout(resolve, 50));
          await waitIdle(session.chat);
        }
        if (turn.cancelled) return { stopReason: "cancelled" satisfies StopReason };
        const failure = turn.failure ?? session.chat.getError()?.message ?? null;
        if (failure) throw requestError(failure);
        return { stopReason: "end_turn" satisfies StopReason };
      } finally {
        stopRelay();
        session.turn = null;
      }
    })
    .onNotification(acp.methods.agent.session.cancel, async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session?.turn) return;
      session.turn.cancelled = true;
      // The app's cancel stops the run for good; closing the stream alone would not (R10).
      await api.cancel(session.id, session.holder).catch(() => undefined);
    });

  const connection = app.connect(options.stream);
  void connection.closed.finally(() => {
    for (const session of sessions.values()) {
      clearInterval(session.renew);
      void api.lease(session.id, session.holder, "release").catch(() => undefined);
    }
    sessions.clear();
  });
  return connection;
}
