// Minimal stand-in for `codex app-server --listen stdio://`: newline-delimited JSON-RPC
// without the "jsonrpc" field, like codex. Only what the tests exercise.
import { createInterface } from "node:readline";

// Options arrive as arguments: the client passes codex only a fixed, minimal environment.
const completeLogin = process.argv.includes("--complete-login");
const authUrl =
  process.argv.find((arg) => arg.startsWith("--auth-url="))?.slice("--auth-url=".length) ??
  "https://auth.openai.com/oauth/authorize?client_id=x";

let signedIn = process.argv.includes("--signed-in");
let nextServerRequest = 1000;
let nextThread = 1;
const pendingServerRequests = new Map();
const threads = new Map();
const log = [];

const write = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const reply = (id, result) => write({ id, result });
const fail = (id, code, message) => write({ id, error: { code, message } });
const notify = (method, params) => write({ method, params });

/** Sends a request to the client and resolves with its reply frame. */
function callClient(method, params) {
  const id = nextServerRequest++;
  const answer = new Promise((resolve) => pendingServerRequests.set(id, resolve));
  write({ id, method, params });
  return answer;
}

const models = [
  {
    id: "m-fast",
    model: "fast-1",
    displayName: "Fast",
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }],
    description: "",
  },
  {
    id: "m-secret",
    model: "secret-1",
    displayName: "Hidden",
    hidden: true,
    isDefault: false,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }],
    description: "",
  },
  {
    id: "m-deep",
    model: "deep-1",
    displayName: "Deep",
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "" },
      { reasoningEffort: "high", description: "" },
    ],
    description: "",
  },
];

async function streamAnswer(threadId, turnId, text) {
  for (const piece of text.match(/.{1,6}/gsu) ?? [])
    notify("item/agentMessage/delta", { threadId, turnId, itemId: "msg-1", delta: piece });
  notify("thread/tokenUsage/updated", {
    threadId,
    turnId,
    tokenUsage: { last: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  });
  notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", items: [] } });
}

async function runTurn(threadId, turnId, input) {
  const thread = threads.get(threadId);
  const text = input.map((part) => part.text ?? "").join(" ");
  const lastHistory = thread.history.at(-1);
  const toolText = (answer) =>
    answer.result?.contentItems?.map((item) => item.text).join(", ") ??
    `error ${answer.error?.code}`;

  if (input.length === 0 && lastHistory?.type === "function_call_output")
    return streamAnswer(threadId, turnId, `Resumed with ${lastHistory.output}`);
  if (text.includes("remember")) {
    const answer = await callClient("item/tool/call", {
      threadId,
      turnId,
      callId: "call-memory",
      tool: "find_memory",
      arguments: { query: "SQLite 결정" },
    });
    if (thread.interrupted) return;
    const found = JSON.parse(toolText(answer));
    return streamAnswer(threadId, turnId, `Found: ${found.matches?.[0]?.snippet ?? "nothing"}`);
  }
  if (text.includes("shell")) {
    const answer = await callClient("item/tool/call", {
      threadId,
      turnId,
      callId: "call-shell",
      tool: "run_shell",
      arguments: { command: "printf approved-output", reason: "check the shell" },
    });
    if (thread.interrupted) return;
    return streamAnswer(threadId, turnId, `Shell said ${toolText(answer)}`);
  }
  if (text.includes("fail"))
    return notify("error", { threadId, turnId, willRetry: false, error: { message: "boom" } });
  if (text.includes("parallel")) {
    const answers = await Promise.all(
      ["Seoul", "Busan"].map((city, index) =>
        callClient("item/tool/call", {
          threadId,
          turnId,
          callId: `call-${index}`,
          tool: "get_weather",
          arguments: { city },
        }),
      ),
    );
    if (thread.interrupted) return;
    return streamAnswer(threadId, turnId, `Both: ${answers.map(toolText).join(" | ")}`);
  }
  if (text.includes("weather")) {
    const answer = await callClient("item/tool/call", {
      threadId,
      turnId,
      callId: "call-1",
      tool: "get_weather",
      arguments: { city: "Seoul" },
    });
    if (thread.interrupted) return;
    return streamAnswer(threadId, turnId, `Weather says ${toolText(answer)}`);
  }
  return streamAnswer(threadId, turnId, `Hello from ${thread.model}`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.method === undefined) {
    // Reply to a request this server sent.
    pendingServerRequests.get(frame.id)?.(frame);
    return;
  }
  const { id, method, params } = frame;
  if (!method.startsWith("test/")) log.push({ method, params });
  switch (method) {
    case "initialize":
      return reply(id, {
        codexHome: process.env.CODEX_HOME,
        platformFamily: "unix",
        platformOs: "macos",
        userAgent: "fake",
      });
    case "initialized":
      return;
    case "account/read":
      return reply(id, {
        account: signedIn
          ? { type: "chatgpt", email: "private@example.com", planType: "plus" }
          : null,
        requiresOpenaiAuth: true,
      });
    case "account/login/start":
      reply(id, { type: "chatgpt", loginId: "login-1", authUrl });
      if (completeLogin)
        setTimeout(() => {
          signedIn = true;
          notify("account/login/completed", { loginId: "login-1", success: true, error: null });
        }, 20);
      return;
    case "account/login/cancel":
      return reply(id, { status: "canceled" });
    case "account/logout":
      signedIn = false;
      return reply(id, {});
    case "model/list":
      // Two pages so cursor handling is exercised.
      return params?.cursor
        ? reply(id, { data: models.slice(2), nextCursor: null })
        : reply(id, { data: models.slice(0, 2), nextCursor: "page-2" });
    case "thread/start": {
      const threadId = `thread-${nextThread++}`;
      threads.set(threadId, { model: params.model, history: [], interrupted: false });
      return reply(id, { thread: { id: threadId } });
    }
    case "thread/inject_items":
      threads.get(params.threadId).history.push(...params.items);
      return reply(id, {});
    case "turn/start": {
      const turnId = `turn-${params.threadId}`;
      reply(id, { turn: { id: turnId } });
      setTimeout(() => void runTurn(params.threadId, turnId, params.input), 5);
      return;
    }
    case "turn/interrupt":
      threads.get(params.threadId).interrupted = true;
      reply(id, {});
      return notify("turn/completed", {
        threadId: params.threadId,
        turn: { id: params.turnId, status: "interrupted", items: [] },
      });
    case "thread/unsubscribe":
      return reply(id, {});
    case "test/log":
      return reply(id, { log });
    case "test/env":
      return reply(id, {
        home: process.env.HOME ?? null,
        codexHome: process.env.CODEX_HOME ?? null,
        path: process.env.PATH ?? null,
        pid: process.pid,
      });
    case "test/callClient":
      return void callClient(params.method, params.params).then((answer) => reply(id, answer));
    case "test/exit":
      return process.exit(3);
    case "test/fail":
      return fail(id, -32602, "invalid params");
    default:
      return fail(id, -32601, `unknown method ${method}`);
  }
});
