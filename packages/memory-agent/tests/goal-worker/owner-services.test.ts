// Actual SDK worker threads, loopback HTTP and native SDK generators exercise owner services that
// stay central while each Goal turn runs elsewhere.
import { DatabaseSync } from "node:sqlite";
import { threadId, type Worker } from "node:worker_threads";
import {
  Cause,
  Context,
  Crypto,
  Deferred,
  Effect,
  Fiber,
  Layer,
  MutableHashMap,
  Option,
  Result,
  Schema,
  Stream,
} from "effect";
import { expect } from "vite-plus/test";
import { makeAgentChatImplementation } from "../../src/agent/chat.ts";
import { chatPersistence } from "../../src/chat-state/persistence.ts";
import { GlobalConfig } from "../../src/config/global-config.ts";
import { Database } from "../../src/db/database.ts";
import { Embedder } from "../../src/memory/embedding/embedder.ts";
import { Indexer } from "../../src/memory/embedding/indexer.ts";
import { Nodes } from "../../src/memory/nodes.ts";
import { createOAuthAccountLoginManager } from "../../src/oauth/account-login.ts";
import { createProfileCredentialStore, OAuthProfiles } from "../../src/oauth/accounts.ts";
import { providerProtocols, type NormalizedStreamEvent } from "../../src/oauth/protocol.ts";
import {
  OAuthValidationHarness,
  type CredentialStore,
  type StoredCredential,
} from "../../src/oauth/validation-harness.ts";
import { ProviderUnavailable } from "../../src/providers/contracts.ts";
import { ProviderRegistry } from "../../src/providers/registry.ts";
import type { StreamingOAuthClient } from "../../src/providers/subscription-adapter.ts";
import { nativeStream } from "../../src/runtime/native-stream.ts";
import { fakeVector } from "../../src/testing/fake-embedder.ts";
import {
  HttpServerRequest,
  HttpServerResponse,
  testHttpClient,
  testHttpServer,
} from "../support/http.ts";
import { type AgentServices, TestEnv, testAgent } from "../support/test-env.ts";
import { waitUntil } from "../support/wait-until.ts";
import {
  chatRequest,
  freshSession,
  goalSession,
  invocations,
  responder,
  responseJson,
  responseText,
  rows,
  send,
} from "./goal-session.ts";

const sdkCall = <A>(call: () => A | PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  });

interface Ownership {
  databaseOpens: number;
  activeDatabases: number;
  maxActiveDatabases: number;
  embedderOwners: number;
  activeEmbedders: number;
  maxActiveEmbedders: number;
  readonly sdkWorkers: number[];
  readonly embeddings: { readonly threadId: number; readonly texts: readonly string[] }[];
}

/** What the agent constructed, counted across the block's agent and its reopen. */
const ownership: Ownership = {
  databaseOpens: 0,
  activeDatabases: 0,
  maxActiveDatabases: 0,
  embedderOwners: 0,
  activeEmbedders: 0,
  maxActiveEmbedders: 0,
  sdkWorkers: [],
  embeddings: [],
};

class OwnerDatabase extends DatabaseSync {
  constructor(file: string) {
    super(file);
    ownership.databaseOpens++;
    ownership.activeDatabases++;
    ownership.maxActiveDatabases = Math.max(
      ownership.maxActiveDatabases,
      ownership.activeDatabases,
    );
  }
  override close() {
    super.close();
    ownership.activeDatabases--;
  }
}

const countedEmbedder = Layer.effect(
  Embedder,
  Effect.acquireRelease(
    Effect.sync(() => {
      ownership.embedderOwners++;
      ownership.activeEmbedders++;
      ownership.maxActiveEmbedders = Math.max(
        ownership.maxActiveEmbedders,
        ownership.activeEmbedders,
      );
      return {
        identity: "fake-trigram-384",
        dimensions: 384,
        embed: (texts: readonly string[]) =>
          Effect.sync(() => {
            ownership.embeddings.push({ threadId, texts });
            return texts.map(fakeVector);
          }),
        runtime: () => ({ kind: "other" as const }),
      };
    }),
    () => Effect.sync(() => void ownership.activeEmbedders--),
  ),
);

const query = "central owner embedding proof";

testAgent({
  openDatabase: (file) => new OwnerDatabase(file),
  goalWorker: { onWorker: (worker) => ownership.sdkWorkers.push(worker.threadId) },
  embedder: countedEmbedder,
  testProvider: { responder },
})("central owner services", (it) => {
  it.effect(
    "an SDK worker turn keeps the DB and embedding backend in one central owner",
    () =>
      Effect.gen(function* () {
        const env = yield* TestEnv;
        const id = yield* goalSession("Keep storage and embedding owned centrally", (invocation) =>
          invocation.messages.some((message) => message.role === "tool")
            ? { text: "central owner complete" }
            : {
                toolCalls: [
                  {
                    id: "owner-embed-call",
                    name: "find_memory",
                    arguments: JSON.stringify({ query }),
                  },
                ],
              },
        );
        const runId = `${id}-central`;
        const response = yield* send(id, runId, "search memory");
        expect(response.status).toBe(200);
        expect(yield* responseText(response)).toContain("central owner complete");
        const indexAll = env.use(Effect.flatMap(Indexer, (indexer) => indexer.indexAll()));
        yield* indexAll;
        expect(yield* env.use(Effect.flatMap(Indexer, (indexer) => indexer.pending))).toBe(0);
        const vectors = () => rows("SELECT * FROM node_vectors ORDER BY node_seq");
        const stored = yield* vectors();
        expect(stored.length).toBeGreaterThan(0);
        const embeddings = ownership.embeddings.length;
        expect(ownership).toMatchObject({
          databaseOpens: 1,
          activeDatabases: 1,
          maxActiveDatabases: 1,
          embedderOwners: 1,
          activeEmbedders: 1,
          maxActiveEmbedders: 1,
        });
        expect(ownership.sdkWorkers).toHaveLength(1);
        expect(ownership.sdkWorkers[0]).not.toBe(threadId);
        expect(
          ownership.embeddings.some((call) => call.texts.some((text) => text.includes(query))),
        ).toBe(true);
        expect(ownership.embeddings.every((call) => call.threadId === threadId)).toBe(true);
        const status = () => rows("SELECT status FROM chat_runs WHERE run_id = ?", runId);
        expect(yield* status()).toEqual([{ status: "completed" }]);

        yield* env.reopen;
        expect(yield* indexAll).toBe(0);
        expect(ownership.embeddings).toHaveLength(embeddings);
        expect(yield* vectors()).toEqual(stored);
        expect(yield* status()).toEqual([{ status: "completed" }]);
        expect(ownership).toMatchObject({
          databaseOpens: 2,
          maxActiveDatabases: 1,
          embedderOwners: 2,
          maxActiveEmbedders: 1,
        });
        expect(ownership.sdkWorkers).toHaveLength(1);
      }),
    20_000,
  );
});

const workers: Worker[] = [];

testAgent({
  goalWorker: { onWorker: (worker) => workers.push(worker) },
  testProvider: { responder },
})("central OAuth owner", (it) => {
  it.effect(
    "account callback and PKCE survive actual SDK worker termination without restarting login",
    () =>
      Effect.gen(function* () {
        const { sqlite } = yield* Database;
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
        const grants: URLSearchParams[] = [];
        const writes: number[] = [];
        let loginStarts = 0;
        const slots = MutableHashMap.empty<string, StoredCredential>();
        const store = (slot: string): CredentialStore => ({
          read: () => Promise.resolve(Option.getOrNull(MutableHashMap.get(slots, slot))),
          write: (_provider, credential) => {
            writes.push(threadId);
            MutableHashMap.set(slots, slot, credential);
            return Promise.resolve();
          },
          remove: () => {
            MutableHashMap.remove(slots, slot);
            return Promise.resolve();
          },
        });
        const { url } = yield* testHttpServer(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            if (request.url !== "/token") return HttpServerResponse.empty({ status: 404 });
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
          authorizeUrl: `${url}/authorize`,
          tokenUrl: `${url}/token`,
          callbackPort: null,
        };
        const id = yield* goalSession("OAuth remains centrally owned", () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.as({ text: "must not complete terminated run" }),
          ),
        );
        const runId = `${id}-worker-demise`;
        const response = yield* send(id, runId, "wait");
        const streaming = yield* Effect.forkChild(responseText(response), {
          startImmediately: true,
        });
        yield* Deferred.await(entered);
        expect(workers).toHaveLength(1);
        expect(workers[0]!.threadId).not.toBe(threadId);
        const manager = createOAuthAccountLoginManager({
          profiles: yield* OAuthProfiles,
          accounts: createProfileCredentialStore(store),
          startLogin: (_provider, slot) => {
            loginStarts++;
            return OAuthValidationHarness({ protocol, store: store(slot) }).startLogin({
              timeoutMs: 5000,
            });
          },
        });
        yield* Effect.addFinalizer(() =>
          sdkCall(() => manager.cancel("openai")).pipe(Effect.orDie),
        );
        const pending = yield* sdkCall(() => manager.start("openai", "owner account"));
        expect(pending.login.status).toBe("pending");
        const authorization = new URL(pending.login.authorizationUrl!);
        const callback = new URL(authorization.searchParams.get("redirect_uri")!);
        callback.searchParams.set("code", "fake-code");
        callback.searchParams.set("state", authorization.searchParams.get("state")!);
        expect(grants).toHaveLength(0);

        yield* sdkCall(() => workers[0]!.terminate());
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(streaming);
        yield* waitUntil(
          () =>
            Schema.is(Schema.Struct({ status: Schema.Literal("failed") }))(
              sqlite.prepare("SELECT status FROM chat_runs WHERE run_id = ?").get(runId),
            ),
          "terminated worker run fails",
          1000,
        );
        expect((yield* manager.profiles("openai")).login.status).toBe("pending");
        const client = yield* testHttpClient();
        expect((yield* client.get(callback.toString())).status).toBe(200);
        yield* waitUntil(
          Effect.map(manager.profiles("openai"), (state) => state.login.status === "completed"),
          "owner login completes",
          1000,
        );
        expect((yield* manager.profiles("openai")).profiles).toMatchObject([
          { label: "owner account", selected: true },
        ]);
        expect(writes).toEqual([threadId]);
        expect(grants[0]!.get("redirect_uri")).toBe(authorization.searchParams.get("redirect_uri"));
        const digest = yield* (yield* Crypto.Crypto).digest(
          "SHA-256",
          new TextEncoder().encode(grants[0]!.get("code_verifier")!),
        );
        expect(Buffer.from(digest).toString("base64url")).toBe(
          authorization.searchParams.get("code_challenge"),
        );
        const closed = yield* Effect.result(client.get(callback.toString()));
        expect(Result.isFailure(closed)).toBe(true);
        expect(grants).toHaveLength(1);
        expect(loginStarts).toBe(1);
        expect(workers).toHaveLength(1);

        const wrong = yield* sdkCall(() => manager.start("openai", "wrong state"));
        const wrongCallback = new URL(
          new URL(wrong.login.authorizationUrl!).searchParams.get("redirect_uri")!,
        );
        wrongCallback.searchParams.set("code", "fake-code");
        wrongCallback.searchParams.set("state", "wrong-state");
        expect((yield* client.get(wrongCallback.toString())).status).toBe(400);
        yield* waitUntil(
          Effect.map(manager.profiles("openai"), (state) =>
            Schema.is(
              Schema.Struct({
                status: Schema.Literal("error"),
                error: Schema.Literal("login_failed"),
              }),
            )(state.login),
          ),
          "wrong OAuth state rejected",
          1000,
        );
        expect(grants).toHaveLength(1);
        expect((yield* manager.profiles("openai")).profiles).toHaveLength(1);
      }),
    20_000,
  );
});

interface DependencyLog {
  readonly acquired: number[];
  readonly released: number[];
}

/**
 * The registry with subscription dependencies acquired per adapter, logging each acquisition and
 * release under `owner`.
 */
const countedDependencies = Effect.fnUntraced(function* (
  log: DependencyLog,
  owner: number,
  stream: () => AsyncGenerator<NormalizedStreamEvent>,
) {
  const registry = yield* ProviderRegistry;
  return {
    ...registry,
    subscriptionDependencies: () =>
      Effect.sync(() => {
        log.acquired.push(owner);
        return {
          client: (): StreamingOAuthClient => ({
            releaseRun: () => void log.released.push(owner),
            stream,
          }),
        };
      }),
  };
});

const failingStream = () =>
  nativeStream(
    Stream.fail(new Cause.UnknownError(undefined, "model check must precede streaming")),
  );

testAgent({ testProvider: {} })("native chat factory", (it) => {
  it.effect("reacquires central dependencies per construction and per adapter", () =>
    Effect.gen(function* () {
      const id = yield* freshSession();
      yield* (yield* GlobalConfig).update({
        provider: "openai",
        model: "missing-model",
        reasoningEffort: "low",
      });
      const log: DependencyLog = { acquired: [], released: [] };
      for (const owner of [1, 2]) {
        const registry = yield* countedDependencies(log, owner, failingStream);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const chat = yield* makeAgentChatImplementation();
            for (const turn of [1, 2]) {
              const response = yield* chat.handle(
                yield* chatRequest(id, `${id}-${owner}-${turn}`),
                id,
              );
              expect(response.status).toBe(409);
              expect(yield* responseJson(response)).toMatchObject({
                error: "model_unavailable_for_account",
              });
            }
          }),
        ).pipe(Effect.provideService(ProviderRegistry, registry));
      }
      expect(log).toEqual({ acquired: [1, 1, 2, 2], released: [1, 1, 2, 2] });
      expect(yield* invocations(id)).toHaveLength(0);
    }),
  );

  it.effect("two fresh constructions stream and persist successful turns", () =>
    Effect.gen(function* () {
      const id = yield* freshSession();
      const nodes = yield* Nodes;
      const persistence = yield* chatPersistence;
      const log: DependencyLog = { acquired: [], released: [] };
      const streamed: number[] = [];
      for (const owner of [1, 2]) {
        const answer = `native-owner-${owner}`;
        const registry = yield* countedDependencies(log, owner, () =>
          nativeStream(
            Stream.suspend(() => {
              streamed.push(owner);
              return Stream.make<NormalizedStreamEvent[]>(
                { type: "text", text: answer },
                { type: "usage", promptTokens: 10, completionTokens: 5 },
              );
            }),
          ),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const chat = yield* makeAgentChatImplementation();
            expect(log.acquired).toHaveLength(owner - 1);
            const response = yield* chat.handle(yield* chatRequest(id, `${id}-${owner}`), id);
            expect(response.status).toBe(200);
            expect(response.headers.get("Content-Type")).toContain("text/event-stream");
            const text = yield* responseText(response);
            expect(text).toContain(answer);
            expect(text).toContain("RUN_FINISHED");
            expect(log.released).toHaveLength(owner);
            expect(
              (yield* nodes.session(id))
                .filter((node) => node.kind === "assistant")
                .map((node) => node.text),
            ).toContain(answer);
            const messages = yield* sdkCall(() => persistence.stores.messages.loadThread(id));
            expect(
              messages
                .filter((message) => message.role === "assistant")
                .map((message) => message.content),
            ).toContain(answer);
          }),
        ).pipe(Effect.provideService(ProviderRegistry, registry));
      }
      expect(log).toEqual({ acquired: [1, 2], released: [1, 2] });
      expect(streamed).toEqual([1, 2]);
      expect(yield* invocations(id)).toHaveLength(0);
    }),
  );

  it.effect("a custom ActiveProvider context works without a ProviderRegistry service", () =>
    Effect.gen(function* () {
      const id = yield* freshSession();
      yield* Effect.scoped(
        Effect.gen(function* () {
          expect(Option.isNone(yield* Effect.serviceOption(ProviderRegistry))).toBe(true);
          const chat = yield* makeAgentChatImplementation();
          const response = yield* chat.handle(yield* chatRequest(id, `${id}-custom`), id);
          expect(response.status).toBe(200);
          yield* responseText(response);
        }),
      ).pipe(
        Effect.updateContext((context: Context.Context<AgentServices>) =>
          Context.omit(ProviderRegistry)(context),
        ),
      );
      expect((yield* invocations(id)).length).toBeGreaterThan(0);
    }),
  );

  it.effect("a failing dependency method never falls back to a custom runtime", () =>
    Effect.gen(function* () {
      const id = yield* freshSession();
      const registry = yield* ProviderRegistry;
      const request = yield* chatRequest(id, `${id}-unavailable`);
      const response = yield* Effect.scoped(
        Effect.flatMap(makeAgentChatImplementation(), (chat) => chat.handle(request, id)),
      ).pipe(
        Effect.provideService(ProviderRegistry, {
          ...registry,
          subscriptionDependencies: (provider) =>
            Effect.fail(new ProviderUnavailable({ provider })),
        }),
      );
      expect(response.status).toBe(503);
      expect(yield* invocations(id)).toHaveLength(0);
    }),
  );
});
