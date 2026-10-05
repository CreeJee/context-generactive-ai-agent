import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ok } from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { RrsiSettings } from "./rrsi";

afterEach(() => vi.unstubAllGlobals());

test("settings remain visible while loading and a missing backend API reports restart guidance", async () => {
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
    vi.stubGlobal("fetch", async () => new Response("Not Found", { status: 404 }));
    const loading = render();
    expect(loading).toContain("동작 개선 실험");
    expect(loading).toContain("개선 실험 설정을 불러오는 중이에요.");
    const query = client.getQueryCache().find({ queryKey: ["settings", "rrsi"] });
    ok(query);
    await expect(query.fetch()).rejects.toThrow("앱 서버를 재시작");
    const failure = render();
    expect(failure).toContain("동작 개선 실험");
    expect(failure).toContain("앱 서버를 재시작");
    expect(failure).toContain("다시 시도");
    expect(failure).not.toContain("평가 시작");
  } finally {
    client.clear();
  }
});

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
    expect(page).toContain("별도의 코딩·기억 과제");
    expect(page).toContain("500,000");
    expect(page).toContain("아직 적용된 개선이 없어요");
    expect(page).toContain("현재 설정의 기본 동작을 평가");
    expect(page).toContain("토큰 사용량은 평가에 든 비용");
  } finally {
    client.clear();
  }
});

test("a failed query can recover and display experiment controls", async () => {
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
    vi.stubGlobal("fetch", async () => {
      return Promise.reject(new TypeError("connection unavailable"));
    });
    render();
    const query = client.getQueryCache().find({ queryKey: ["settings", "rrsi"] });
    ok(query);
    await expect(query.fetch()).rejects.toThrow("connection unavailable");
    expect(render()).toContain("connection unavailable");
    vi.stubGlobal("fetch", async () =>
      Response.json({
        settings: { enabled: false, maxMinutes: 30 },
        current: { id: "baseline" },
        versions: [],
        experiments: [],
        running: false,
        configuredRepository: true,
      }),
    );
    await query.fetch();
    const recovered = render();
    expect(recovered).toContain("평가 시작");
    expect(recovered).toContain("아직 적용된 개선이 없어요");
    expect(recovered).not.toContain("connection unavailable");
  } finally {
    client.clear();
  }
});
