import { it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, afterEach, expect, test, vi } from "vite-plus/test";
import {
  AppliedSettings,
  CandidateDetails,
  ExperimentSummary,
  candidateLabel,
} from "./rrsi-summary";
import type { ExperimentRecord, HarnessVersion } from "memory-agent";
import { RrsiSettings } from "./rrsi";

beforeEach(() => vi.stubGlobal("location", new URL("http://localhost/settings")));
afterEach(() => vi.unstubAllGlobals());
const sdkCall = Effect.fn("rrsiSettingsTest.sdkCall")(function* <A>(
  operation: () => A | PromiseLike<A>,
) {
  return yield* Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (cause) => new Cause.UnknownError(cause),
  });
});

it.live(
  "settings remain visible while loading and a missing backend API reports restart guidance",
  () =>
    Effect.gen(function* () {
      const client = new QueryClient({
        defaultOptions: { queries: { retryOnMount: false, gcTime: Infinity } },
      });
      const render = () =>
        renderToStaticMarkup(
          <QueryClientProvider client={client}>
            <RrsiSettings />
          </QueryClientProvider>,
        );
      try {
        vi.stubGlobal("fetch", () => Promise.resolve(new Response("Not Found", { status: 404 })));
        const loading = render();
        expect(loading).toContain("동작 개선 실험");
        expect(loading).toContain("개선 실험 설정을 불러오는 중이에요.");
        const query = yield* Effect.fromNullishOr(
          client.getQueryCache().find({ queryKey: ["settings", "rrsi"] }),
        );
        yield* sdkCall(() => expect(query.fetch()).rejects.toThrow("앱 서버를 재시작"));
        const failure = render();
        expect(failure).toContain("동작 개선 실험");
        expect(failure).toContain("앱 서버를 재시작");
        expect(failure).toContain("다시 시도");
        expect(failure).not.toContain("평가 시작");
      } finally {
        client.clear();
      }
    }),
);

test("high evaluation cost is not presented as an applied improvement", () => {
  const client = new QueryClient();
  try {
    client.setQueryData(["settings", "rrsi"], {
      settings: { enabled: false, maxMinutes: 30 },
      current: { id: "baseline" },
      versions: [],
      running: true,
      experiments: [
        { id: "fixture", startedAt: 0, status: "running", tokens: 500000, candidates: [] },
      ],
    });
    const page = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <RrsiSettings />
      </QueryClientProvider>,
    );
    expect(page).toContain("프로젝트 공통");
    expect(page).toContain("실제 사용 기록에서 정정한 내용");
    expect(page).toContain("500,000");
    expect(page).toContain("아직 적용된 개선이 없어요");
    expect(page).toContain("정확한 완료 개수를 알 수 없어요");
    expect(page).toContain("이 평가에서 적용된 변경은 없어요");
    expect(page).toContain("토큰 사용량은 평가에 든 비용");
  } finally {
    client.clear();
  }
});

it.live("a failed query can recover and display experiment controls", () =>
  Effect.gen(function* () {
    const client = new QueryClient({
      defaultOptions: { queries: { retryOnMount: false, gcTime: Infinity } },
    });
    const render = () =>
      renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <RrsiSettings />
        </QueryClientProvider>,
      );
    try {
      vi.stubGlobal("fetch", () => Promise.reject(new TypeError("connection unavailable")));
      render();
      const query = yield* Effect.fromNullishOr(
        client.getQueryCache().find({ queryKey: ["settings", "rrsi"] }),
      );
      yield* sdkCall(() => expect(query.fetch()).rejects.toThrow("connection unavailable"));
      // The browser's transport text stays out of the page.
      expect(render()).toContain("요청을 처리하지 못했어요");
      vi.stubGlobal("fetch", () =>
        Promise.resolve(
          Response.json({
            settings: { enabled: false, maxMinutes: 30 },
            current: { id: "baseline" },
            versions: [],
            experiments: [],
            running: false,
            configuredRepository: true,
          }),
        ),
      );
      yield* sdkCall(() => query.fetch());
      const recovered = render();
      expect(recovered).toContain("평가 시작");
      expect(recovered).toContain("아직 적용된 개선이 없어요");
      expect(recovered).not.toContain("connection unavailable");
    } finally {
      client.clear();
    }
  }),
);

const baseline: HarnessVersion = {
  id: "baseline",
  parentId: null,
  kind: "profile",
  sourceCommit: null,
  artifactHash: "fixture",
  createdAt: 0,
  profile: {
    rolePrompt: "",
    memoryToolDescription: "",
    retrievalLeadLimit: 5,
    retrievalTokenLimit: 600,
  },
};

test("adopted settings show concrete changes, previous instructions and Goal scope", () => {
  const current: HarnessVersion = {
    ...baseline,
    id: "adopted",
    parentId: "baseline",
    profile: {
      rolePrompt: "검증 결과를 확인하세요.",
      memoryToolDescription: "출처를 함께 읽으세요.",
      retrievalLeadLimit: 3,
      retrievalTokenLimit: 400,
    },
  };
  const page = renderToStaticMarkup(
    <AppliedSettings current={current} versions={[current, baseline]} />,
  );
  expect(page).toContain("5개 → 3개");
  expect(page).toContain("600토큰 → 400토큰");
  expect(page).toContain("검증 결과를 확인하세요.");
  expect(page).toContain("이전 설정과 지침 비교");
  expect(page).toContain("진행 중인 Goal은 시작할 때의 설정");
  expect(page).toContain("일반 채팅은 기본 설정");
});

test("a held-out rejection shows the result that rejected it and readable candidate changes", () => {
  const measured = (score: number, memory: number) => ({ score, coding: 1, memory, tokens: 1 });
  const candidate = {
    kind: "profile" as const,
    imageId: null,
    round: 0,
    edits: [],
    measurement: measured(0.667, 0.333),
    decision: "round_winner",
    profile: baseline.profile,
    diff: JSON.stringify({
      before: baseline.profile,
      after: {
        ...baseline.profile,
        retrievalTokenLimit: 1200,
        memoryToolDescription: "출처를 읽으세요.",
      },
    }),
    branch: "rrsi/fixture/0/1",
    commit: "fixture",
  };
  const experiment: ExperimentRecord = {
    id: "rejected",
    status: "completed",
    startedAt: 0,
    finishedAt: 1,
    model: "fixture",
    endpoint: "fixture",
    baseVersion: "baseline",
    memoryTasks: { kind: "usage", version: "a2a89b757e51" },
    tokens: 1,
    reason: "heldout_rejected",
    validationBase: measured(0.583, 0.167),
    validationNew: measured(0.833, 0.667),
    sealedBase: measured(0.75, 0.5),
    sealedNew: measured(0.583, 0.167),
    candidates: [
      { ...candidate, id: "first" },
      { ...candidate, id: "second" },
    ],
  };
  const page = renderToStaticMarkup(
    <ExperimentSummary
      experiment={experiment}
      reason="최종 평가를 통과하지 못했어요"
      nextStep="현재 설정은 바뀌지 않았어요."
      scope="history"
    />,
  );
  expect(page).toContain("최종 확인 과제 성공률: 현재 설정 75.0% → 후보 58.3%");
  expect(page).toContain("기억 50.0% → 16.7%");
  expect(page).toContain("버전 a2a89b757e51");
  expect(page).toContain("다음: 현재 설정은 바뀌지 않았어요.");
  expect(page).not.toContain("최근 평가 결과");
  expect(candidateLabel(experiment.candidates, 1)).toBe("라운드 1 · 후보 2");
  const details = renderToStaticMarkup(<CandidateDetails candidate={experiment.candidates[1]} />);
  expect(details).toContain("기억 검색 길이 600토큰 → 1200토큰");
  expect(details).toContain("기억 검색 도구의 추가 안내 추가");
  expect(details).not.toContain("rrsi/fixture");
});

test("a cancelled evaluation retains its last task checkpoint without implying adoption", () => {
  const experiment: ExperimentRecord = {
    id: "cancelled",
    status: "cancelled",
    startedAt: 0,
    finishedAt: 1,
    model: "fixture",
    endpoint: "fixture",
    baseVersion: "baseline",
    tokens: 500000,
    candidates: [],
    reason: "time_limit",
    progress: { phase: "baseline", completed: 7, total: 36 },
  };
  const page = renderToStaticMarkup(
    <ExperimentSummary experiment={experiment} reason="설정한 평가 시간이 끝나 중단했어요" />,
  );
  expect(page).toContain("7/36 과제 완료");
  expect(page).toContain("마지막 기록된 단계");
  expect(page).toContain("이 평가에서 적용된 변경은 없어요");
  expect(page).toContain("설정한 평가 시간이 끝나");
  const adopted = renderToStaticMarkup(
    <ExperimentSummary
      experiment={{ ...experiment, adoptedVersionId: "adopted" }}
      reason="설정한 평가 시간이 끝나 중단했어요"
    />,
  );
  expect(adopted).toContain("검증된 설정을 채택했어요");
  expect(adopted).not.toContain("적용된 변경은 없어요");
});
