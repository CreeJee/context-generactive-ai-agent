import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Option, Schema } from "effect";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { bundledCodex, nativeConfig, type Json } from "../src/codex/app-server.ts";

/**
 * Every other codex test runs against the fake app server, which accepts any `-c` line and any
 * request. So a config key or a request the real codex rejects — renamed after a version bump, or
 * never right — passes the whole suite and only fails when a user starts the app. These start the
 * pinned binary with the exact configuration the app sends.
 */
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const failure = /Error loading config|invalid type|unknown field|unknown feature key/u;

const Reply = Schema.Struct({
  id: Schema.optional(Schema.Number),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
});
const decodeReply = Schema.decodeUnknownOption(Schema.parseJson(Reply));

/** The pinned codex app-server with a throwaway CODEX_HOME (also its folder) and HOME. */
function startCodex(executable: string, home: string) {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-config-"));
  const child = spawn(
    executable,
    ["app-server", "--listen", "stdio://", ...nativeConfig.flatMap((line) => ["-c", line])],
    { cwd: codexHome, env: { ...process.env, CODEX_HOME: codexHome, HOME: home }, stdio: "pipe" },
  );
  cleanups.push(() => {
    child.kill();
    rmSync(codexHome, { recursive: true, force: true });
  });

  let output = "";
  let buffer = "";
  let next = 1;
  const waiting = new Map<number, (reply: typeof Reply.Type) => void>();
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const reply = Option.getOrUndefined(decodeReply(line));
      if (reply?.id !== undefined) waiting.get(reply.id)?.(reply);
    }
  });

  const request = (method: string, params: { readonly [key: string]: Json }) =>
    new Promise<typeof Reply.Type>((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(() => reject(new Error(`${method} timed out:\n${output}`)), 20_000);
      waiting.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  return { codexHome, request, output: () => output };
}

const SkillList = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      skills: Schema.Array(Schema.Struct({ path: Schema.String, enabled: Schema.Boolean })),
    }),
  ),
});
const Written = Schema.Struct({ effectiveEnabled: Schema.Boolean });

describe.skipIf(bundledCodex() === null)("the pinned codex", () => {
  test("accepts the configuration this app starts it with", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const codex = startCodex(bundledCodex()!, home);

    const initialized = await codex.request("initialize", {
      clientInfo: { name: "config-test", title: "config test", version: "0" },
    });
    expect(failure.exec(codex.output())?.[0] ?? null).toBeNull();
    expect(initialized.error).toBeUndefined();
  }, 30_000);

  test("lists the user's skills and turns one off by its SKILL.md path", async () => {
    // What codex reads on its own: the user's ~/.agents/skills.
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const skill = join(home, ".agents", "skills", "probe");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: probe\ndescription: A probe.\n---\nBody.");
    const codex = startCodex(bundledCodex()!, home);
    await codex.request("initialize", {
      clientInfo: { name: "config-test", title: "config test", version: "0" },
    });

    const listed = async () => {
      const reply = await codex.request("skills/list", { cwds: [codex.codexHome] });
      return Schema.decodeUnknownSync(SkillList)(reply.result)
        .data.flatMap((group) => group.skills)
        .filter((entry) => entry.path.endsWith(join("probe", "SKILL.md")));
    };
    const [before] = await listed();
    expect(before?.enabled).toBe(true);

    const written = await codex.request("skills/config/write", {
      path: before?.path,
      enabled: false,
    });
    expect(Schema.decodeUnknownSync(Written)(written.result).effectiveEnabled).toBe(false);
    expect((await listed())[0]?.enabled).toBe(false);
    // Kept in this app's CODEX_HOME; the user's ~/.codex is never written.
    const saved = join(codex.codexHome, "config.toml");
    expect(existsSync(saved) && readFileSync(saved, "utf8")).toContain(before?.path ?? "missing");
    expect(existsSync(join(home, ".codex"))).toBe(false);
  }, 30_000);
});
