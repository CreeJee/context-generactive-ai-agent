import { it } from "@effect/vitest";
import { Cause, Effect } from "effect";
import { describe, expect, vi } from "vite-plus/test";
import { ApiError, chatFetch } from "../api";

const call = <A>(execute: () => Promise<A>) =>
  Effect.tryPromise({ try: execute, catch: (cause) => new Cause.UnknownError(cause) });

describe("chat transport errors", () => {
  it.effect("preserves a provider failure code from a rejected stream response", () =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllGlobals()));
      vi.stubGlobal("fetch", () =>
        Promise.resolve(
          Response.json(
            { error: "provider_auth_unavailable", provider: "openai" },
            { status: 503 },
          ),
        ),
      );
      expect(
        (yield* Effect.flip(call(() => chatFetch("http://localhost/api/chat")))).cause,
      ).toMatchObject({
        status: 503,
        code: "provider_auth_unavailable",
      } satisfies Partial<ApiError>);
    }),
  );
});
