import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { threadId, type Worker } from "node:worker_threads";
import { Effect } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { AgentChat } from "../src/agent/chat.ts";
import { Database } from "../src/db/database.ts";
import { createOAuthAccountLoginManager } from "../src/oauth/account-login.ts";
import { createProfileCredentialStore } from "../src/oauth/accounts.ts";
import { providerProtocols } from "../src/oauth/protocol.ts";
import {
  OAuthValidationHarness,
  type CredentialStore,
  type StoredCredential,
} from "../src/oauth/validation-harness.ts";
import { Workflows } from "../src/workflow/workflow.ts";
import { testRuntime } from "./support/runtime.ts";

const observed = vi.hoisted(() => {
  const workers: Worker[] = [];
  return { workers };
});
vi.mock("node:worker_threads", async (load) => {
  const original = await load<typeof import("node:worker_threads")>();
  return {
    ...original,
    Worker: class extends original.Worker {
      constructor(...args: ConstructorParameters<typeof original.Worker>) {
        super(...args);
        if (String(args[0]).endsWith("/full-loop-worker.ts")) observed.workers.push(this);
      }
    },
  };
});

test("central account callback and PKCE survive actual SDK worker termination without restarting login", async () => {
  const previous = process.env.CONTEXT_AGENT_GOAL_WORKER;
  process.env.CONTEXT_AGENT_GOAL_WORKER = "1";
  let releaseModel!: () => void;
  let modelEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    modelEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  let tokenRequests = 0;
  let loginStarts = 0;
  const grants: URLSearchParams[] = [];
  const writes: number[] = [];
  const slots = new Map<string, StoredCredential>();
  const store = (id: string): CredentialStore => ({
    read: async () => slots.get(id) ?? null,
    write: async (_provider, credential) => {
      writes.push(threadId);
      slots.set(id, credential);
    },
    remove: async () => {
      slots.delete(id);
    },
  });
  const server = createServer(async (request, response) => {
    if (request.url !== "/token") {
      response.writeHead(404).end();
      return;
    }
    tokenRequests++;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    grants.push(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        access_token: "fake-access",
        refresh_token: "fake-refresh",
        expires_in: 3600,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // SAFETY: the test server listens on an ephemeral TCP loopback address.
  const { port } = server.address() as AddressInfo;
  const protocol = {
    ...providerProtocols.openai,
    authorizeUrl: `http://127.0.0.1:${port}/authorize`,
    tokenUrl: `http://127.0.0.1:${port}/token`,
    callbackPort: null,
  };
  let manager: ReturnType<typeof createOAuthAccountLoginManager> | undefined;
  try {
    const context = await testRuntime({
      testProvider: {
        responder: async () => {
          modelEntered();
          await gate;
          return { text: "must not complete terminated run" };
        },
      },
    });
    await context.provider!.select(context.runtime);
    const { chat, db, workflows } = await context.runtime.runPromise(
      Effect.all({ chat: AgentChat, db: Database, workflows: Workflows }),
    );
    await context.runtime.runPromise(
      workflows.updateGoal(context.session.id, {
        statement: "OAuth remains centrally owned",
        outcomes: ["Worker failure does not cancel owner login"],
        constraints: [],
        nonGoals: [],
        assumptions: [],
        openQuestions: [],
        status: "active",
      }),
    );
    const response = await context.runtime.runPromise(
      chat.handle(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Run-Id": "oauth-worker-demise" },
          body: JSON.stringify({
            threadId: context.session.id,
            runId: "oauth-worker-demise",
            messages: [{ id: "m1", role: "user", content: "wait" }],
            tools: [],
            context: [],
          }),
        }),
        context.session.id,
      ),
    );
    const stream = response.text();
    await entered;
    expect(observed.workers).toHaveLength(1);
    expect(observed.workers[0]!.threadId).not.toBe(threadId);
    manager = createOAuthAccountLoginManager(
      db.sqlite,
      createProfileCredentialStore(store),
      async (_provider, id) => {
        loginStarts++;
        return OAuthValidationHarness({ protocol, store: store(id) }).startLogin({
          timeoutMs: 5000,
        });
      },
    );
    const pending = await manager.start("openai", "owner account");
    expect(pending.login.status).toBe("pending");
    const auth = new URL(pending.login.authorizationUrl!);
    const callback = new URL(auth.searchParams.get("redirect_uri")!);
    callback.searchParams.set("code", "fake-code");
    callback.searchParams.set("state", auth.searchParams.get("state")!);
    expect(tokenRequests).toBe(0);
    await observed.workers[0]!.terminate();
    releaseModel();
    await stream;
    await vi.waitFor(() =>
      expect(
        db.sqlite
          .prepare("SELECT status FROM chat_runs WHERE run_id = ?")
          .get("oauth-worker-demise"),
      ).toEqual({ status: "failed" }),
    );
    expect(manager.profiles("openai").login.status).toBe("pending");
    expect((await fetch(callback)).status).toBe(200);
    await vi.waitFor(() => expect(manager!.profiles("openai").login.status).toBe("completed"));
    expect(manager.profiles("openai").profiles).toMatchObject([
      { label: "owner account", selected: true },
    ]);
    expect(writes).toEqual([threadId]);
    expect(grants[0]!.get("redirect_uri")).toBe(auth.searchParams.get("redirect_uri"));
    expect(createHash("sha256").update(grants[0]!.get("code_verifier")!).digest("base64url")).toBe(
      auth.searchParams.get("code_challenge"),
    );
    // A completed one-shot callback is closed, not transferred or restarted.
    await expect(fetch(callback)).rejects.toThrow();
    expect(tokenRequests).toBe(1);
    expect(loginStarts).toBe(1);
    expect(observed.workers).toHaveLength(1);
    const wrong = await manager.start("openai", "wrong state");
    const wrongAuth = new URL(wrong.login.authorizationUrl!);
    const wrongCallback = new URL(wrongAuth.searchParams.get("redirect_uri")!);
    wrongCallback.searchParams.set("code", "fake-code");
    wrongCallback.searchParams.set("state", "wrong-state");
    expect((await fetch(wrongCallback)).status).toBe(400);
    await vi.waitFor(() =>
      expect(manager!.profiles("openai").login).toEqual({ status: "error", error: "login_failed" }),
    );
    expect(tokenRequests).toBe(1);
    expect(manager.profiles("openai").profiles).toHaveLength(1);
  } finally {
    releaseModel?.();
    await manager?.cancel("openai");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.CONTEXT_AGENT_GOAL_WORKER;
    else process.env.CONTEXT_AGENT_GOAL_WORKER = previous;
  }
}, 20000);
