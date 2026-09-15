// Minimal stand-in for `codex app-server --listen stdio://`: newline-delimited JSON-RPC
// without the "jsonrpc" field, like codex. Only what the tests exercise.
import { existsSync } from "node:fs";
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
    inputModalities: ["text"],
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

  if (thread.instructions.includes("You review one tool call")) {
    // Permission reviewer: the verdict depends on markers in the reviewed arguments.
    const reviewed = text.match(/Arguments \(JSON\): (.*)$/s)?.[1] ?? "";
    if (reviewed.includes("broken-review")) return streamAnswer(threadId, turnId, "not a verdict");
    const decision = reviewed.includes("block-me")
      ? "block"
      : reviewed.includes("ask-me")
        ? "ask"
        : "allow";
    const reason = `검토 결과: ${decision}`;
    return streamAnswer(threadId, turnId, JSON.stringify({ decision, reason }));
  }
  if (thread.instructions.includes("You label statements")) {
    // Interpreter: topics from #hashtags, links from markers like [corrects:WORD], aimed at the
    // first candidate (users first) whose text contains WORD. [maybe-...] is ambiguous.
    const input = JSON.parse(text.match(/Input \(JSON\): (.*)$/s)?.[1] ?? "{}");
    if (input.statements?.some((statement) => statement.text.includes("[broken-interpret]")))
      return streamAnswer(threadId, turnId, "not json at all");
    const statements = (input.statements ?? []).map((statement) => {
      const topics = [...statement.text.matchAll(/#(\S+)/gu)].map((match) => match[1]);
      const links = [
        ...statement.text.matchAll(/\[(maybe-)?(corrects|retracts|related):([^\]]+)\]/gu),
      ].flatMap(([, maybe, relation, word]) => {
        const containing = statement.candidates.filter((candidate) =>
          candidate.text.includes(word),
        );
        const target = containing.find((candidate) => candidate.role === "user") ?? containing[0];
        if (!target) return [];
        return [
          {
            target: target.id,
            relation,
            certainty: maybe ? "ambiguous" : "clear",
            reason: `${word} 관련`,
          },
        ];
      });
      if (statement.text.includes("[bad-target]"))
        links.push({
          target: "not-offered",
          relation: "corrects",
          certainty: "clear",
          reason: "x",
        });
      return { id: statement.id, topics, links };
    });
    return streamAnswer(threadId, turnId, JSON.stringify({ statements }));
  }
  const toolCall = text.match(/^call (\S+) (\{.*\})$/s);
  if (toolCall) {
    // "call TOOL {json}" calls any tool with those arguments and repeats what it returned.
    const answer = await callClient("item/tool/call", {
      threadId,
      turnId,
      callId: `call-${toolCall[1]}`,
      tool: toolCall[1],
      arguments: JSON.parse(toolCall[2]),
    });
    if (thread.interrupted) return;
    return streamAnswer(threadId, turnId, `${toolCall[1]} said ${toolText(answer)}`);
  }
  if (text.includes("look at")) {
    const local = input.filter((part) => part.type === "localImage");
    const replayed = thread.history
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === "input_image");
    const readable = local.filter((part) => existsSync(part.path));
    return streamAnswer(
      threadId,
      turnId,
      `Saw ${readable.length} new image(s) and ${replayed.length} earlier image(s)`,
    );
  }
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
    // "shell: <command>" runs that command; plain "shell" runs a fixed one.
    const command = text.match(/shell: (.*)$/s)?.[1]?.trim() ?? "printf approved-output";
    const answer = await callClient("item/tool/call", {
      threadId,
      turnId,
      callId: "call-shell",
      tool: "run_shell",
      arguments: { command, reason: "check the shell" },
    });
    if (thread.interrupted) return;
    return streamAnswer(threadId, turnId, `Shell said ${toolText(answer)}`);
  }
  if (text.includes("slow")) {
    // A long answer, one piece every 40ms, that stops when the turn is interrupted.
    for (let piece = 1; piece <= 50; piece++) {
      if (thread.interrupted) return;
      notify("item/agentMessage/delta", { threadId, turnId, itemId: "msg-1", delta: `${piece} ` });
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    if (thread.steered.length === 0) return streamAnswer(threadId, turnId, "done");
    // Like codex, a steered message is answered in a second message item of the same turn.
    notify("item/agentMessage/delta", { threadId, turnId, itemId: "msg-1", delta: "done" });
    for (const piece of `steered: ${thread.steered.join(" / ")}`.match(/.{1,6}/gsu) ?? [])
      notify("item/agentMessage/delta", { threadId, turnId, itemId: "msg-2", delta: piece });
    return streamAnswer(threadId, turnId, "");
  }
  if (text.includes("check files")) {
    // Waits a moment before its tool call, so a test can queue a message for that boundary.
    await new Promise((resolve) => setTimeout(resolve, 700));
    await callClient("item/tool/call", {
      threadId,
      turnId,
      callId: "call-files",
      tool: "list_files",
      arguments: {},
    });
    if (thread.interrupted) return;
    const heard = thread.steered.length > 0 ? thread.steered.join(" / ") : "nothing";
    return streamAnswer(threadId, turnId, `Files checked. Heard: ${heard}`);
  }
  if (text.includes("nap")) {
    // Takes a moment, so tests can tell parallel subagents from sequential ones.
    await new Promise((resolve) => setTimeout(resolve, 700));
    if (thread.interrupted) return;
    return streamAnswer(threadId, turnId, `napped: ${text}`);
  }
  if (text.includes("delegate twice")) {
    const answers = await Promise.all(
      ["nap A", "nap B"].map((task, index) =>
        callClient("item/tool/call", {
          threadId,
          turnId,
          callId: `call-delegate-${index}`,
          tool: "run_subagent",
          arguments: { task },
        }),
      ),
    );
    if (thread.interrupted) return;
    return streamAnswer(threadId, turnId, `Both: ${answers.map(toolText).join(" | ")}`);
  }
  if (text.includes("fail"))
    return notify("error", { threadId, turnId, willRetry: false, error: { message: "boom" } });
  const sequential = text.match(/^sequential weather (\d+)$/);
  if (sequential) {
    // One call at a time, each after the previous result, like a model reading files one by one.
    const answers = [];
    for (let index = 0; index < Number(sequential[1]); index++) {
      answers.push(
        await callClient("item/tool/call", {
          threadId,
          turnId,
          callId: `call-seq-${index}`,
          tool: "get_weather",
          arguments: { city: `City${index}` },
        }),
      );
      if (thread.interrupted) return;
    }
    return streamAnswer(
      threadId,
      turnId,
      `Looked up ${answers.length}: ${answers.map(toolText).join(" | ")}`,
    );
  }
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
  if (thread.instructions.includes("You are a subagent")) {
    const earlier = thread.history.filter((item) => item.role === "user").length;
    return streamAnswer(
      threadId,
      turnId,
      `child done: ${text} (earlier user messages: ${earlier})`,
    );
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
      threads.set(threadId, {
        model: params.model,
        instructions: params.baseInstructions ?? "",
        history: [],
        steered: [],
        interrupted: false,
      });
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
    case "turn/steer": {
      const thread = threads.get(params.threadId);
      if (!thread || params.expectedTurnId !== `turn-${params.threadId}`)
        return fail(id, -32600, "no active turn");
      thread.steered.push(params.input.map((part) => part.text ?? "").join(" "));
      return reply(id, { turnId: params.expectedTurnId });
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
