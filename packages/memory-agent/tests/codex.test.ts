import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { userInfo, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Either, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { CodexAccount, isChatgptAuthUrl } from "../src/codex/account.ts";
import { CodexAppServer, findCodex } from "../src/codex/app-server.ts";
import { CodexModels } from "../src/codex/models.ts";
import { GlobalConfig } from "../src/config/global-config.ts";
import { StorageRoot } from "../src/config/storage-root.ts";

const fakeServer = fileURLToPath(new URL("./support/fake-codex.mjs", import.meta.url));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function codexRuntime(...flags: string[]) {
  const storage = realpathSync(mkdtempSync(join(tmpdir(), "memory-agent-codex-")));
  const foundation = StorageRoot.layer(storage);
  const server = CodexAppServer.withCommand({
    executable: process.execPath,
    args: [fakeServer, ...flags],
  });
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(CodexAccount.layer, CodexModels.layer).pipe(
      Layer.provideMerge(Layer.merge(server, GlobalConfig.layer)),
      Layer.provideMerge(foundation),
    ),
  );
  cleanups.push(async () => {
    await runtime.dispose();
    rmSync(storage, { recursive: true, force: true });
  });
  return { runtime, storage };
}

const Env = Schema.Struct({
  home: Schema.NullOr(Schema.String),
  codexHome: Schema.NullOr(Schema.String),
  path: Schema.NullOr(Schema.String),
  pid: Schema.Number,
});

describe("CodexAppServer", () => {
  test("starts lazily with an app-owned CODEX_HOME and a minimal environment", async () => {
    const { runtime, storage } = codexRuntime();
    const env = await runtime.runPromise(
      Effect.flatMap(CodexAppServer, (codex) => codex.request("test/env", undefined, Env)),
    );
    expect(env.codexHome).toBe(join(storage, "codex"));
    expect(env.path).toBe("/usr/bin:/bin");
    if (process.platform === "darwin") expect(env.home).toBe(userInfo().homedir);
  });

  test("refuses server-initiated requests nobody registered, and answers registered ones", async () => {
    const { runtime } = codexRuntime();
    const Reply = Schema.Struct({
      result: Schema.optional(Schema.Unknown),
      error: Schema.optional(Schema.Struct({ code: Schema.Number })),
    });
    const callClient = (method: string) =>
      runtime.runPromise(
        Effect.flatMap(CodexAppServer, (codex) =>
          codex.request("test/callClient", { method, params: { tool: "find_memory" } }, Reply),
        ),
      );

    expect((await callClient("item/tool/call")).error?.code).toBe(-32601);

    const codex = await runtime.runPromise(CodexAppServer);
    codex.onRequest("item/tool/call", async () => ({ contentItems: [], success: true }));
    expect((await callClient("item/tool/call")).result).toEqual({
      contentItems: [],
      success: true,
    });
  });

  test("reports codex errors and restarts after the process exits, without retrying", async () => {
    const { runtime } = codexRuntime();
    const run = <A, E>(effect: Effect.Effect<A, E, CodexAppServer>) =>
      runtime.runPromise(Effect.either(effect));
    const request = (method: string) =>
      Effect.flatMap(CodexAppServer, (codex) => codex.request(method, undefined, Env));

    const failed = await run(request("test/fail"));
    expect(Either.isLeft(failed) && failed.left).toMatchObject({
      _tag: "CodexRequestFailed",
      method: "test/fail",
    });

    const first = await run(request("test/env"));
    const exited = await run(request("test/exit"));
    expect(Either.isLeft(exited) && exited.left).toMatchObject({
      _tag: "CodexUnavailable",
      reason: "exited",
    });
    const second = await run(request("test/env"));
    expect(
      Either.isRight(first) && Either.isRight(second) && first.right.pid !== second.right.pid,
    ).toBe(true);
  });

  test("reports a missing codex binary instead of throwing", async () => {
    expect(findCodex("relative/bin:/definitely/not/here")).toBeNull();
  });
});

describe("CodexAccount", () => {
  test("walks signed-out -> pending -> signed-in -> signed-out without exposing account details", async () => {
    const { runtime } = codexRuntime("--complete-login");
    const account = await runtime.runPromise(CodexAccount);

    expect(await runtime.runPromise(account.status)).toEqual({ status: "signed-out" });
    const pending = await runtime.runPromise(account.login);
    expect(pending).toEqual({
      status: "pending",
      authUrl: "https://auth.openai.com/oauth/authorize?client_id=x",
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const signedIn = await runtime.runPromise(account.status);
    expect(signedIn).toEqual({ status: "signed-in", planType: "plus" });
    expect(JSON.stringify(signedIn)).not.toContain("private@example.com");
    expect(await runtime.runPromise(account.logout)).toEqual({ status: "signed-out" });
  });

  test("cancels a login whose URL is not the ChatGPT authorize page", async () => {
    const { runtime } = codexRuntime("--auth-url=https://evil.example/oauth/authorize");
    const state = await runtime.runPromise(
      Effect.flatMap(CodexAccount, (account) => account.login),
    );
    expect(state).toEqual({ status: "error", message: "Codex returned an unexpected login URL." });
    expect(isChatgptAuthUrl("https://auth.openai.com/oauth/authorize?x=1")).toBe(true);
    expect(isChatgptAuthUrl("https://auth.openai.com.evil.example/oauth/authorize")).toBe(false);
    expect(isChatgptAuthUrl("http://auth.openai.com/oauth/authorize")).toBe(false);
  });
});

describe("CodexModels", () => {
  test("lists visible models across pages and saves only an offered model and effort", async () => {
    const { runtime, storage } = codexRuntime();
    const models = await runtime.runPromise(CodexModels);

    expect((await runtime.runPromise(models.list)).map((model) => model.model)).toEqual([
      "fast-1",
      "deep-1",
    ]);
    expect(await runtime.runPromise(models.selected)).toBeNull();

    const hidden = await runtime.runPromise(Effect.either(models.select("secret-1")));
    expect(Either.isLeft(hidden) && hidden.left).toMatchObject({
      _tag: "ModelUnavailable",
      model: "secret-1",
    });
    const badEffort = await runtime.runPromise(Effect.either(models.select("fast-1", "high")));
    expect(Either.isLeft(badEffort) && badEffort.left).toMatchObject({
      _tag: "ModelUnavailable",
      reasoningEffort: "high",
    });

    expect(await runtime.runPromise(models.select("deep-1"))).toEqual({
      model: "deep-1",
      reasoningEffort: "medium",
    });
    expect(await runtime.runPromise(models.selected)).toEqual({
      model: "deep-1",
      reasoningEffort: "medium",
    });
    expect(JSON.parse(readFileSync(join(storage, "config.json"), "utf8"))).toEqual({
      model: "deep-1",
      reasoningEffort: "medium",
    });
  });
});
