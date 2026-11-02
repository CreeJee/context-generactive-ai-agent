import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { gitNames } from "../src/files/git-grep.ts";
import { searchTextFilesEffect } from "../src/files/search.ts";
import { PathRejected } from "../src/files/paths.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

it.effect(
  "read-ahead completion order does not change matches and disappeared files are omitted",
  () =>
    Effect.gen(function* () {
      const first = yield* Deferred.make<void>();
      const second = yield* Deferred.make<void>();
      const searched = yield* Effect.forkChild(
        searchTextFilesEffect({
          paths: ["first", "second", "gone"],
          query: "match",
          caseSensitive: true,
          start: { file: 0, line: 0 },
          readBytes: (path) => {
            switch (path) {
              case "first":
                return Deferred.await(first).pipe(Effect.as(bytes("match first")));
              case "second":
                return Deferred.succeed(second, undefined).pipe(Effect.as(bytes("match second")));
              default:
                return Effect.fail(PathRejected.make({ path, reason: "not_found" }));
            }
          },
        }),
      );
      yield* Deferred.await(second);
      yield* Deferred.succeed(first, undefined);
      expect(yield* Fiber.join(searched)).toEqual({
        matches: [
          { path: "first", line: 1, text: "match first" },
          { path: "second", line: 1, text: "match second" },
        ],
        skipped: [],
        next: null,
      });
    }),
);

it.effect("Git names split across chunks and stop one past the limit", () =>
  Effect.gen(function* () {
    const chunks = ["a\0b", "c\0", "\0d\0e", "\0f\0"].map((text) => new TextEncoder().encode(text));
    expect(yield* gitNames({ stdout: Stream.fromIterable(chunks), limit: 10 })).toEqual({
      names: ["a", "bc", "d", "e", "f"],
      truncated: false,
    });
    // An endless output still ends: reading stops one name past the limit.
    const endless = Stream.fromEffectRepeat(Effect.succeed(new TextEncoder().encode("x\0")));
    expect(yield* gitNames({ stdout: endless, limit: 3 })).toEqual({
      names: ["x", "x", "x"],
      truncated: true,
    });
  }),
);
