import { it } from "@effect/vitest";
import { Cause, FileSystem, Path } from "effect";
import { withTestPlatform } from "./support/platform.ts";
import { Array as EffectArray } from "effect";
import { HashSet } from "effect";
import { chat, toolDefinition } from "@tanstack/ai";
import { Effect, Layer, Schema } from "effect";
import { build } from "vite";
import { expect } from "vite-plus/test";
import type * as NativeArtifact from "../src/agent/native-artifact-entry.ts";
import { Embedder } from "../src/memory/embedding/embedder.ts";
import { PermissionReviews } from "../src/permissions/reviews.ts";
import { Sessions } from "../src/sessions/sessions.ts";
import { fakeVector } from "../src/testing/fake-embedder.ts";
import { ScriptedTextAdapter } from "../src/testing/scripted-adapter.ts";
import { permissionReviewInterrupt } from "../src/tools/definitions.ts";
import { testRuntime } from "./support/runtime.ts";

// Test-only bytes lifetime, not production loading, whole-Goal pinning or cold recovery.
it.live(
  "late-first native bundles retain permission refusal helper and fresh central bindings",
  () =>
    withTestPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const join = pathService.join;
        const root = yield* pathService.fromFileUrl(new URL("../", import.meta.url));
        const temporary = yield* fs.makeTempDirectoryScoped({
          directory: root,
          prefix: ".native-capability-lifetime-",
        });
        const source = join(temporary, "src");
        yield* fs.copy(join(root, "src"), source);
        const allowed = HashSet.fromIterable([
          "effect",
          "@effect/platform-node",
          "@tanstack/ai",
          "@secretlint/core",
          "@secretlint/profiler",
          "@secretlint/secretlint-rule-preset-recommend",
        ]);
        const external = (id: string) => {
          if (id.startsWith("node:")) return true;
          if (id.startsWith(".") || id.startsWith("/") || id.startsWith("\0")) return false;
          const name = id.startsWith("@") ? id.split("/").slice(0, 2).join("/") : id.split("/")[0];
          if (!HashSet.has(allowed, name)) throw new Error(`Unexpected host dependency: ${id}`);
          return true;
        };
        const bundle = Effect.fn("NativeArtifactTest.bundle")(function* (name: string) {
          const result = yield* sdkCall(() =>
            build({
              configFile: false,
              root,
              logLevel: "silent",
              build: {
                write: false,
                minify: false,
                lib: { entry: join(source, "agent/native-artifact-entry.ts"), formats: ["es"] },
                rollupOptions: { external },
              },
            }),
          );
          const outputs = Array.isArray(result) ? result : [result];
          expect(outputs).toHaveLength(1);
          // SAFETY: finite non-watch build with configFile:false; output length checked above.
          const output = outputs[0] as Extract<
            Awaited<ReturnType<typeof build>>,
            { output: unknown }
          >;
          const chunks = output.output.filter((item) => item.type === "chunk");
          expect(chunks).toHaveLength(1);
          const chunk = chunks[0]!;
          expect(chunk.exports.toSorted()).toEqual(
            [
              "createMemoryTools",
              "createSubscriptionRuntimeImplementation",
              "makePermissionGateMiddleware",
              "makeRecordingMiddleware",
            ].toSorted(),
          );
          expect(Object.keys(chunk.modules)).toContain(join(source, "permissions/gate.ts"));
          expect(chunk.imports.every(external)).toBe(true);
          expect(chunk.imports).toContain("effect");
          expect(chunk.imports).toContain("@tanstack/ai");
          expect(Buffer.byteLength(chunk.code)).toBeLessThan(2_000_000);
          const path = join(temporary, `${name}.mjs`);
          yield* fs.writeFileString(path, chunk.code, { flag: "wx" });
          return { path, code: chunk.code };
        });
        const a = yield* bundle("a");
        const implementation = join(source, "permissions/gate.ts");
        const original = yield* fs.readFileString(implementation);
        const needle = "return { error: `blocked_by_permission_review: ${review.reason}` };";
        expect(original.split(needle)).toHaveLength(2);
        // Mutate the actual refusal helper only; keep authorization decisions unchanged.
        yield* fs.writeFileString(
          implementation,
          original.replace(
            needle,
            "return { error: `copied-B:blocked_by_permission_review: ${review.reason}` };",
          ),
        );
        const b = yield* bundle("b");
        expect(b.code).not.toBe(a.code);
        expect(yield* fs.readFileString(a.path)).toBe(a.code);
        yield* fs.remove(source, { recursive: true });

        let embedderOwners = 0;
        const owner = yield* sdkCall(() =>
          testRuntime({
            embedder: Layer.sync(Embedder, () => {
              embedderOwners++;
              return {
                identity: "fake-trigram-64",
                dimensions: 64,
                embed: (texts) => Effect.succeed(texts.map(fakeVector)),
                runtime: () => ({ kind: "other" }),
              };
            }),
          }),
        );
        const reviews = yield* Effect.provideContext(
          PermissionReviews,
          yield* owner.runtime.contextEffect,
        );
        // Both FIRST evaluations happen after mutation and source deletion.
        const artifactUrlA = (yield* pathService.toFileUrl(a.path)).href;
        const artifactA: typeof NativeArtifact = yield* sdkCall(
          () => import(/* @vite-ignore */ artifactUrlA),
        );
        const artifactUrlB = (yield* pathService.toFileUrl(b.path)).href;
        const artifactB: typeof NativeArtifact = yield* sdkCall(
          () => import(/* @vite-ignore */ artifactUrlB),
        );
        const executed: string[] = [];
        const sessions: string[] = [];
        for (const [label, artifact, prefix] of [
          ["a-first", artifactA, ""],
          ["b", artifactB, "copied-B:"],
          ["a-next", artifactA, ""],
        ] as const) {
          const session = yield* Effect.provideContext(
            Effect.flatMap(Sessions, (service) => service.create(owner.project.id)),
            yield* owner.runtime.contextEffect,
          );
          sessions.push(session.id);
          const reason = `central-${label}`;
          expect(reviews.latest(session.id, "blocked-id")).toBeNull();
          const blockedReview = reviews.record({
            sessionId: session.id,
            toolCallId: "blocked-id",
            toolName: "blocked_tool",
            input: "{}",
            decision: "block",
            decidedBy: "classifier",
            reason,
          });
          const allowedReview = reviews.record({
            sessionId: session.id,
            toolCallId: "allowed-id",
            toolName: "allowed_tool",
            input: "{}",
            decision: "approved",
            decidedBy: "user",
            reason: label,
          });
          const gate = yield* Effect.provideContext(
            artifact.makePermissionGateMiddleware({
              project: owner.project,
              sessionId: session.id,
              selection: { provider: "openai", model: "scripted-1", reasoningEffort: "none" },
              gated: HashSet.fromIterable(["blocked_tool", "allowed_tool"]),
              decider: "user",
            }),
            yield* owner.runtime.contextEffect,
          );
          const adapter = new ScriptedTextAdapter([
            {
              toolCalls: [
                { id: "blocked-id", name: "blocked_tool", arguments: "{}" },
                { id: "allowed-id", name: "allowed_tool", arguments: "{}" },
              ],
            },
            { text: "finished" },
          ]);
          yield* sdkCall(() =>
            chat({
              adapter,
              messages: [],
              runId: label,
              tools: [
                toolDefinition({ name: "blocked_tool", description: "must stay blocked" }).server(
                  () => {
                    executed.push(`UNSAFE:${label}`);
                    return "unexpected";
                  },
                ),
                toolDefinition({
                  name: "allowed_tool",
                  description: "exact central approval",
                }).server(() => {
                  executed.push(label);
                  return `allowed-${label}`;
                }),
              ],
              interrupts: [permissionReviewInterrupt],
              middleware: [gate],
              stream: false,
            }),
          );
          expect(adapter.invocations).toHaveLength(2);
          const messages = adapter.invocations[1]!.messages;
          const refusal = messages.find(
            (message) => message.role === "tool" && message.toolCallId === "blocked-id",
          );
          expect(refusal?.content).toBe(
            yield* Schema.encodeEffect(
              Schema.fromJsonString(Schema.Struct({ error: Schema.String })),
            )({ error: `${prefix}blocked_by_permission_review: ${reason}` }),
          );
          expect(
            messages.find(
              (message) => message.role === "tool" && message.toolCallId === "allowed-id",
            )?.content,
          ).toContain(`allowed-${label}`);
          expect(reviews.latest(session.id, "blocked-id")).toEqual(blockedReview);
          expect(reviews.latest(session.id, "allowed-id")).toEqual(allowedReview);
          // Observable embedder acquisition only, NOT comprehensive singleton ownership proof.
          expect(embedderOwners).toBe(1);
        }
        expect(EffectArray.dedupe(sessions).length).toBe(3);
        expect(executed).toEqual(["a-first", "b", "a-next"]);
        for (const [index, sessionId] of sessions.entries()) {
          expect(reviews.latest(sessionId, "blocked-id")?.reason).toBe(
            `central-${["a-first", "b", "a-next"][index]}`,
          );
        }
      }),
    ),
  60_000,
);

const sdkCall = Effect.fn("NativeArtifactTest.sdkCall")(<A>(call: () => A | PromiseLike<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(call()),
    catch: (cause) => new Cause.UnknownError(cause),
  }),
);
