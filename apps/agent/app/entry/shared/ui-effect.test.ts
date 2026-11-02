import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { ApiError } from "../api";
import { runUiEffect, uiPromise } from "./ui-effect";

it.live("Promise callbacks preserve a server's typed error object", () =>
  Effect.gen(function* () {
    const failure = ApiError.make({ status: 409, code: "not_running", reason: null });
    const rejected = yield* Effect.flip(
      Effect.tryPromise(() => runUiEffect(uiPromise(() => Promise.reject(failure)))),
    );
    expect(rejected.cause).toBe(failure);
  }),
);
