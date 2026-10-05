import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { Rrsi } from "../src/rrsi/service.ts";
import { HarnessStore } from "../src/rrsi/store.ts";
import { Database } from "../src/db/database.ts";
import { GlobalConfig } from "../src/config/global-config.ts";
import { StorageRoot } from "../src/config/storage-root.ts";
import {
  OpenAICompatibleSettings,
  CompatibleFetch,
  CompatibleKeyring,
} from "../src/providers/openai-compatible.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";

interface EvolutionFixture {
  rejectValidation: boolean;
  zeroMemoryBaseline: boolean;
  splits: string[];
  released: number;
}
const fixture = vi.hoisted((): EvolutionFixture => ({
  rejectValidation: false,
  zeroMemoryBaseline: false,
  splits: [],
  released: 0,
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  return {
    ...actual,
    execFile: Object.assign(vi.fn(), {
      [promisify.custom]: async () => ({ stdout: `sha256:${"0".repeat(64)}`, stderr: "" }),
    }),
  };
});
vi.mock("../src/rrsi/model-gateway.ts", async () => {
  const { Effect } = await import("effect");
  return {
    pinModelGateway: () =>
      Effect.succeed({
        protocol: "chat-completions",
        configuration: {
          provider: "openai-compatible",
          model: "fixture",
          baseUrl: "fixture",
          reasoningEffort: "default",
        },
        release: () => {
          fixture.released++;
        },
        complete: async (body: string) => {
          const proposal = body.includes("Propose one reusable");
          return JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify(
                    proposal
                      ? {
                          profile: {
                            rolePrompt: "",
                            memoryToolDescription: "",
                            retrievalLeadLimit: 5,
                            retrievalTokenLimit: 400,
                          },
                          edits: [
                            {
                              component: "memory",
                              hypothesis: "Keep the same quality with less retrieved context.",
                            },
                          ],
                        }
                      : { approved: true },
                  ),
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 1 },
          });
        },
      }),
  };
});
vi.mock("../src/rrsi/sandbox.ts", async (original) => {
  const actual = await original<typeof import("../src/rrsi/sandbox.ts")>();
  return {
    ...actual,
    evaluateSandbox: vi.fn(async (_client, profile, split, _signal, consume, _image, progress) => {
      fixture.splits.push(split);
      consume(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 1 } }));
      progress?.(split === "evolve" ? 12 : 6, split === "evolve" ? 12 : 6);
      const improved = profile.retrievalTokenLimit === 400;
      const regression = fixture.rejectValidation && split === "validation" && improved;
      const memory = regression || (fixture.zeroMemoryBaseline && !improved) ? 0 : 0.5;
      const coding = regression ? 1 : 0.5;
      return {
        score: (coding + memory) / 2,
        coding,
        memory,
        tokens: improved ? 80 : 100,
      };
    }),
  };
});

afterEach(() => vi.unstubAllEnvs());

test.each([
  { reject: false, zeroMemory: false },
  { reject: true, zeroMemory: false },
  { reject: false, zeroMemory: true },
])(
  "evaluation reaches selection and independent validation ($reject, zero-memory=$zeroMemory)",
  async ({ reject, zeroMemory }) => {
    fixture.rejectValidation = reject;
    fixture.zeroMemoryBaseline = zeroMemory;
    fixture.splits = [];
    fixture.released = 0;
    vi.stubEnv("CONTEXT_AGENT_RRSI_REPOSITORY", "");
    vi.stubEnv("CONTEXT_AGENT_RRSI_ORIGINAL_STORAGE", "");
    vi.stubEnv("CONTEXT_AGENT_RRSI_WORKER", "1");
    const directory = mkdtempSync(join(tmpdir(), "rrsi-evolution-"));
    const config = GlobalConfig.layer.pipe(Layer.provide(StorageRoot.layer(directory)));
    const compatible = OpenAICompatibleSettings.layerWith(
      Layer.succeed(CompatibleKeyring, { get: async () => null, set: async () => undefined }),
      Layer.succeed(CompatibleFetch, async () => Response.json({})),
    ).pipe(Layer.provide(config));
    const dependencies = Layer.mergeAll(
      Database.layer(":memory:"),
      config,
      compatible,
      ProviderRegistry.layer([]),
    );
    const runtime = ManagedRuntime.make(
      Rrsi.layer.pipe(
        Layer.provideMerge(HarnessStore.layer.pipe(Layer.provideMerge(dependencies))),
      ),
    );
    try {
      const service = await runtime.runPromise(Rrsi);
      const store = await runtime.runPromise(HarnessStore);
      store.configure({ enabled: false, maxMinutes: 1 });
      const originalGoal = store.forGoal("existing");
      await runtime.runPromise(service.start());
      await expect.poll(async () => (await runtime.runPromise(service.status)).running).toBe(false);
      const record = store.experiments()[0];
      expect(record.status).toBe("completed");
      expect(record.baselines).toHaveLength(3);
      expect(record.candidates.some((candidate) => candidate.decision === "round_winner")).toBe(
        true,
      );
      expect(fixture.splits).toContain("validation");
      expect(store.forGoal("existing").id).toBe(originalGoal.id);
      expect(fixture.released).toBe(1);
      if (reject) {
        expect(record.reason).toBe("validation_rejected");
        expect(fixture.splits).not.toContain("sealed");
        expect(store.current().id).toBe("baseline");
        expect(record.adoptedVersionId).toBeUndefined();
      } else {
        expect(record.reason).toBe("profile_adopted");
        expect(fixture.splits).toContain("sealed");
        expect(store.current().profile.retrievalTokenLimit).toBe(400);
        expect(store.forGoal("new").id).toBe(record.adoptedVersionId);
        expect(await runtime.runPromise(Effect.flip(service.start()))).toMatchObject({
          _tag: "RrsiFailed",
          reason: "sealed_corpus_exhausted",
        });
      }
    } finally {
      await runtime.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
