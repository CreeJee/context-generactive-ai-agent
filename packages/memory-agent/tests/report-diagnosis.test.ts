import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { BundleRun, ReportBundle } from "../src/report/bundle-contract.ts";
import { bundlePlaces, diagnosisDigest, digestLimits } from "../src/report/bundle-digest.ts";
import { parseDiagnosis } from "../src/report/diagnosis.ts";

const text = (value: string) => ({ text: value, cut: false });
const section = <T>(items: readonly T[]) => ({
  status: items.length > 0 ? ("available" as const) : ("empty" as const),
  items,
  truncated: false,
});

const run = (seq: number, failed: boolean): BundleRun => ({
  seq,
  ref: `ref${seq}`,
  status: "completed",
  startedAt: `2026-10-18T00:00:${String(seq % 60).padStart(2, "0")}Z`,
  finishedAt: null,
  error: null,
  eventsCut: false,
  events: [
    { _tag: "Message", role: "user", at: "t", text: text(`ask ${seq}`) },
    {
      _tag: "ToolCall",
      seq: 1,
      name: "read_file",
      at: "t",
      input: text(`{"path":"f${seq}"}`),
      result: { ok: !failed, at: "t", text: text(failed ? `ENOENT f${seq}` : "contents") },
    },
  ],
});

const bundleOf = (runs: readonly BundleRun[]): ReportBundle => ({
  version: 1,
  collectedAt: "2026-10-18T00:00:00Z",
  limits: { runs: 30, eventsPerRun: 60, textChars: 1_500, failureChars: 6_000 },
  environment: {
    release: "1.0.0",
    platform: "darwin-arm64",
    runtime: "node 24",
    provider: "openai",
    model: "gpt",
    kanbanConcurrency: null,
  },
  session: { ref: "abc", title: null, runCount: runs.length },
  integrations: section([]),
  loops: section([]),
  boards: section([]),
  defects: section([]),
  timeline: section(runs),
  unlinked: section([]),
});

describe("report diagnosis answer", () => {
  it.effect("observations without a citation of a place in the bundle become hypotheses", () =>
    Effect.gen(function* () {
      const answer = `\`\`\`json
{"summary":"read_file가 실패했다.","observations":[{"text":"파일을 찾지 못했다.","evidenceIds":["run-2/call-1","made-up"]},{"text":"서버가 재시작됐다.","evidenceIds":["made-up"]}],"hypotheses":[{"text":"경로가 바뀌었을 수 있다."}]}
\`\`\``;
      const places = bundlePlaces(bundleOf([run(1, false), run(2, true)]));
      expect(yield* parseDiagnosis(answer, places)).toEqual({
        summary: "read_file가 실패했다.",
        observations: [{ text: "파일을 찾지 못했다.", evidenceIds: ["run-2/call-1"] }],
        hypotheses: [{ text: "경로가 바뀌었을 수 있다." }, { text: "서버가 재시작됐다." }],
      });
    }),
  );

  it.effect("a non-JSON answer is a typed invalid_answer failure", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(parseDiagnosis("모르겠어요", new Set()));
      expect(failure.reason).toBe("invalid_answer");
    }),
  );
});

describe("diagnosis digest of a bundle", () => {
  it("keeps the newest runs in the outline and details only failing runs, newest first", () => {
    const runs = Array.from({ length: 400 }, (_, index) => run(index + 1, index % 20 === 0));
    const digest = diagnosisDigest(bundleOf(runs));
    const outline = digest.find((item) => item.id === "timeline");
    expect(outline?.text.length).toBeLessThanOrEqual(digestLimits.outlineChars);
    expect(outline?.text).toContain("run-400 ");
    expect(outline?.text).not.toContain("run-1 ");
    const failures = digest.filter((item) => item.id.startsWith("run-"));
    expect(failures).toHaveLength(digestLimits.failureItems);
    expect(failures[0]?.id).toBe("run-381");
    expect(failures[0]?.text).toContain("ENOENT f381");
    expect(failures[0]?.text).toContain("user asked: ask 381");
  });
});
