import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
    expect(loading).toContain("하네스 개선");
    expect(loading).toContain("하네스 설정을 불러오는 중이에요.");
    const query = client.getQueryCache().find({ queryKey: ["settings", "rrsi"] });
    if (!query) throw new Error("missing settings query");
    await expect(query.fetch()).rejects.toThrow("앱 서버를 재시작");
    const failure = render();
    expect(failure).toContain("하네스 개선");
    expect(failure).toContain("앱 서버를 재시작");
    expect(failure).toContain("다시 시도");
    expect(failure).not.toContain("지금 실험");
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
      throw new Error("connection unavailable");
    });
    render();
    const query = client.getQueryCache().find({ queryKey: ["settings", "rrsi"] });
    if (!query) throw new Error("missing settings query");
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
    expect(recovered).toContain("지금 실험");
    expect(recovered).toContain("기본 하네스");
    expect(recovered).not.toContain("connection unavailable");
  } finally {
    client.clear();
  }
});
