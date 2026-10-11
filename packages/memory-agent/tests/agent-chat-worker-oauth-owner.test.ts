// Actual worker threads and loopback HTTP exercise centrally owned OAuth credentials.
import { NodeCrypto } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  testHttpServer,
  testHttpClient,
  HttpServerRequest,
  HttpServerResponse,
} from "./support/http.ts";
import { threadId, type Worker } from "node:worker_threads";
import {
  Crypto,
  Deferred,
  Effect,
  Fiber,
  Layer,
  MutableHashMap,
  Option,
  Result,
  Schema,
} from "effect";
import { expect } from "vite-plus/test";
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
import { waitUntil } from "./support/wait-until.ts";
const sdkCall = <A>(call: () => A | PromiseLike<A>) =>
  Effect.tryPromise(() => Promise.resolve(call()));
const withCrypto = Effect.fn("OAuthOwnerTest.crypto")(function* <A, E, R>(
  program: Effect.Effect<A, E, R>,
) {
  const services = yield* Layer.build(NodeCrypto.layer);
  return yield* Effect.provideContext(program, services);
});

it.live(
  "central account callback and PKCE survive actual SDK worker termination without restarting login",
  () =>
    Effect.scoped(
      withCrypto(
        Effect.gen(function* () {
          const workers: Worker[] = [];
          const entered = yield* Deferred.make<void>();
          const gate = yield* Deferred.make<void>();
          yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
          let tokenRequests = 0;
          let loginStarts = 0;
          const grants: URLSearchParams[] = [];
          const writes: number[] = [];
          const slots = MutableHashMap.empty<string, StoredCredential>();
          const store = (id: string): CredentialStore => ({
            read: () =>
              Promise.resolve(Option.getOrUndefined(MutableHashMap.get(slots, id)) ?? null),
            write: (_provider, credential) => {
              writes.push(threadId);
              MutableHashMap.set(slots, id, credential);
              return Promise.resolve();
            },
            remove: () => {
              MutableHashMap.remove(slots, id);
              return Promise.resolve();
            },
          });
          const { port } = yield* testHttpServer(
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              if (request.url !== "/token") return HttpServerResponse.empty({ status: 404 });
              tokenRequests++;
              grants.push(new URLSearchParams(yield* request.text));
              return yield* HttpServerResponse.json({
                access_token: "fake-access",
                refresh_token: "fake-refresh",
                expires_in: 3600,
              });
            }),
          );
          const protocol = {
            ...providerProtocols.openai,
            authorizeUrl: `http://127.0.0.1:${port}/authorize`,
            tokenUrl: `http://127.0.0.1:${port}/token`,
            callbackPort: null,
          };
          const context = yield* sdkCall(() =>
            testRuntime({
              goalWorker: { onWorker: (worker) => workers.push(worker) },
              testProvider: {
                responder: Effect.fn("heldOAuthOwnerTurn")(function* () {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(gate);
                  return { text: "must not complete terminated run" };
                }),
              },
            }),
          );
          yield* sdkCall(() => context.provider!.select(context.runtime));
          const services = yield* context.runtime.contextEffect;
          const { chat, db, workflows } = yield* Effect.provideContext(
            Effect.all({ chat: AgentChat, db: Database, workflows: Workflows }),
            services,
          );
          yield* Effect.provideContext(
            workflows.updateGoal(context.session.id, {
              statement: "OAuth remains centrally owned",
              outcomes: ["Worker failure does not cancel owner login"],
              constraints: [],
              nonGoals: [],
              assumptions: [],
              openQuestions: [],
              status: "active",
            }),
            services,
          );
          const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            threadId: context.session.id,
            runId: "oauth-worker-demise",
            messages: [{ id: "m1", role: "user", content: "wait" }],
            tools: [],
            context: [],
          });
          const response = yield* Effect.provideContext(
            chat.handle(
              new Request("http://localhost/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Run-Id": "oauth-worker-demise" },
                body,
              }),
              context.session.id,
            ),
            services,
          );
          const stream = yield* Effect.forkChild(
            sdkCall(() => response.text()),
            { startImmediately: true },
          );
          yield* Deferred.await(entered);
          expect(workers).toHaveLength(1);
          expect(workers[0]!.threadId).not.toBe(threadId);
          const manager = createOAuthAccountLoginManager({
            sqlite: db.sqlite,
            accounts: createProfileCredentialStore(store),
            startLogin: (_provider, id) => {
              loginStarts++;
              return OAuthValidationHarness({ protocol, store: store(id) }).startLogin({
                timeoutMs: 5000,
              });
            },
          });
          yield* Effect.addFinalizer(() =>
            sdkCall(() => manager.cancel("openai")).pipe(Effect.orDie),
          );
          const pending = yield* sdkCall(() => manager.start("openai", "owner account"));
          expect(pending.login.status).toBe("pending");
          const auth = new URL(pending.login.authorizationUrl!);
          const callback = new URL(auth.searchParams.get("redirect_uri")!);
          callback.searchParams.set("code", "fake-code");
          callback.searchParams.set("state", auth.searchParams.get("state")!);
          expect(tokenRequests).toBe(0);
          yield* sdkCall(() => workers[0]!.terminate());
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(stream);
          yield* waitUntil(
            () =>
              Schema.is(Schema.Struct({ status: Schema.Literal("failed") }))(
                db.sqlite
                  .prepare("SELECT status FROM chat_runs WHERE run_id = ?")
                  .get("oauth-worker-demise"),
              ),
            "terminated worker run fails",
            1000,
          );
          expect(manager.profiles("openai").login.status).toBe("pending");
          expect((yield* (yield* testHttpClient()).get(callback.toString())).status).toBe(200);
          yield* waitUntil(
            () => manager.profiles("openai").login.status === "completed",
            "owner login completes",
            1000,
          );
          expect(manager.profiles("openai").profiles).toMatchObject([
            { label: "owner account", selected: true },
          ]);
          expect(writes).toEqual([threadId]);
          expect(grants[0]!.get("redirect_uri")).toBe(auth.searchParams.get("redirect_uri"));
          const crypto = yield* Crypto.Crypto;
          const digest = yield* crypto.digest(
            "SHA-256",
            new TextEncoder().encode(grants[0]!.get("code_verifier")!),
          );
          expect(Buffer.from(digest).toString("base64url")).toBe(
            auth.searchParams.get("code_challenge"),
          );
          const closedCallback = yield* Effect.result(
            (yield* testHttpClient()).get(callback.toString()),
          );
          expect(Result.isFailure(closedCallback)).toBe(true);
          if (Result.isFailure(closedCallback))
            expect(closedCallback.failure.reason.cause).toBeInstanceOf(Error);
          expect(tokenRequests).toBe(1);
          expect(loginStarts).toBe(1);
          expect(workers).toHaveLength(1);
          const wrong = yield* sdkCall(() => manager.start("openai", "wrong state"));
          const wrongAuth = new URL(wrong.login.authorizationUrl!);
          const wrongCallback = new URL(wrongAuth.searchParams.get("redirect_uri")!);
          wrongCallback.searchParams.set("code", "fake-code");
          wrongCallback.searchParams.set("state", "wrong-state");
          expect((yield* (yield* testHttpClient()).get(wrongCallback.toString())).status).toBe(400);
          yield* waitUntil(
            () =>
              Schema.is(
                Schema.Struct({
                  status: Schema.Literal("error"),
                  error: Schema.Literal("login_failed"),
                }),
              )(manager.profiles("openai").login),
            "wrong OAuth state rejected",
            1000,
          );
          expect(tokenRequests).toBe(1);
          expect(manager.profiles("openai").profiles).toHaveLength(1);
        }),
      ),
    ),
  20000,
);
