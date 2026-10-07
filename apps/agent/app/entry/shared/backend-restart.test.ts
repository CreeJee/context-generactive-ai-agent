import { it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import { describe, expect, vi } from "vite-plus/test";
import { backendFetch, responseRequiresBackendRestart } from "./backend-restart.ts";
import {
  createDevelopmentBoundary,
  developmentRequestDecision,
} from "../../../server/dev-safety.ts";

const call = <A>(execute: () => Promise<A>) =>
  Effect.tryPromise({ try: execute, catch: (cause) => new Cause.UnknownError(cause) });

describe("development backend restart detection", () => {
  it.effect("direct backend requests carry the client build ID and preserve session headers", () =>
    Effect.gen(function* () {
      const transport = vi.fn<typeof fetch>((_input, init) => {
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
        return Promise.resolve(Response.json({ ok: true }));
      });
      const request = backendFetch("build-a", "http://localhost:5180", transport);
      yield* call(() =>
        request(
          new Request("http://localhost:5180/api/chat", {
            method: "POST",
            headers: { "x-session-holder": "holder" },
          }),
        ),
      );
      expect(transport).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("never sends the build ID to another origin or retries a stale mutation", () =>
    Effect.gen(function* () {
      const transport = vi.fn<typeof fetch>(() =>
        Promise.resolve(Response.json({ error: "backend_restart_required" }, { status: 409 })),
      );
      const request = backendFetch("build-a", "http://localhost:5180", transport);
      yield* call(() => request("https://example.com/api/chat", { method: "POST" }));
      expect(transport.mock.calls[0]?.[1]?.headers).toBeUndefined();
      yield* call(() =>
        request("/api/chat", { method: "POST", headers: { "x-session-holder": "holder" } }),
      );
      expect(transport).toHaveBeenCalledTimes(2);
      expect(new Headers(transport.mock.calls[1]?.[1]?.headers).get("x-session-holder")).toBe(
        "holder",
      );
    }),
  );

  it.effect("recognizes both stable-backend rejection responses without consuming the body", () =>
    Effect.gen(function* () {
      for (const error of ["backend_restart_required", "backend_restarting"] as const) {
        const response = Response.json(
          { error },
          { status: error === "backend_restarting" ? 503 : 409 },
        );

        expect(yield* call(() => responseRequiresBackendRestart(response))).toBe(true);
        expect(yield* call(() => response.json())).toEqual({ error });
      }
    }),
  );

  it.effect("ignores unrelated and successful responses", () =>
    Effect.gen(function* () {
      expect(
        yield* call(() =>
          responseRequiresBackendRestart(
            Response.json({ error: "run_in_progress" }, { status: 409 }),
          ),
        ),
      ).toBe(false);
      expect(
        yield* call(() =>
          responseRequiresBackendRestart(Response.json({ error: "backend_restart_required" })),
        ),
      ).toBe(false);
    }),
  );
});
