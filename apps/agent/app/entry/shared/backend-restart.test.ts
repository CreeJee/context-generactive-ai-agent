import { describe, expect, test, vi } from "vite-plus/test";
import { backendFetch, responseRequiresBackendRestart } from "./backend-restart.ts";
import {
  createDevelopmentBoundary,
  developmentRequestDecision,
} from "../../../server/dev-safety.ts";

describe("development backend restart detection", () => {
  test("direct backend requests carry the client build ID and preserve session headers", async () => {
    const transport = vi.fn<typeof fetch>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-session-holder")).toBe("holder");
      expect(
        developmentRequestDecision(
          createDevelopmentBoundary("build-a"),
          "POST",
          "/api/chat",
          headers.get("x-context-agent-build-id") ?? undefined,
        ),
      ).toEqual({ kind: "allow" });
      return Response.json({ ok: true });
    });
    const request = backendFetch("build-a", "http://localhost:5180", transport);
    await request(
      new Request("http://localhost:5180/api/chat", {
        method: "POST",
        headers: { "x-session-holder": "holder" },
      }),
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  test("never sends the build ID to another origin or retries a stale mutation", async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      Response.json({ error: "backend_restart_required" }, { status: 409 }),
    );
    const request = backendFetch("build-a", "http://localhost:5180", transport);
    await request("https://example.com/api/chat", { method: "POST" });
    expect(transport.mock.calls[0]?.[1]?.headers).toBeUndefined();
    await request("/api/chat", { method: "POST", headers: { "x-session-holder": "holder" } });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(new Headers(transport.mock.calls[1]?.[1]?.headers).get("x-session-holder")).toBe(
      "holder",
    );
  });

  test("recognizes both stable-backend rejection responses without consuming the body", async () => {
    for (const error of ["backend_restart_required", "backend_restarting"] as const) {
      const response = Response.json(
        { error },
        { status: error === "backend_restarting" ? 503 : 409 },
      );

      await expect(responseRequiresBackendRestart(response)).resolves.toBe(true);
      await expect(response.json()).resolves.toEqual({ error });
    }
  });

  test("ignores unrelated and successful responses", async () => {
    await expect(
      responseRequiresBackendRestart(Response.json({ error: "run_in_progress" }, { status: 409 })),
    ).resolves.toBe(false);
    await expect(
      responseRequiresBackendRestart(Response.json({ error: "backend_restart_required" })),
    ).resolves.toBe(false);
  });
});
