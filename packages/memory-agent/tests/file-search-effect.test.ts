import { expect, it } from "@effect/vitest";
import { assertTrue } from "@effect/vitest/utils";
import { Deferred, Effect, Cause, Exit, Fiber } from "effect";
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
                return Effect.fail(new PathRejected({ path, reason: "not_found" }));
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

it.effect("finishing a page interrupts all pending read-ahead work", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let active = 0;
    let finished = 0;
    const page = yield* searchTextFilesEffect({
      paths: Array.from({ length: 5 }, (_, index) => String(index)),
      query: "match",
      caseSensitive: true,
      start: { file: 0, line: 0 },
      readBytes: (path) =>
        path === "0"
          ? Deferred.await(started).pipe(
              Effect.as(bytes(Array.from({ length: 101 }, () => "match").join("\n"))),
            )
          : Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  active--;
                  finished++;
                }),
              );
              active++;
              if (active === 4) yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }),
    });
    expect(page.matches).toHaveLength(100);
    expect(page.next).toEqual({ file: 0, line: 100 });
    expect(active).toBe(0);
    expect(finished).toBe(4);
  }),
);

it.effect("reader defects are not converted into skipped files", () =>
  Effect.gen(function* () {
    const defect = new Error("reader bug");
    const exit = yield* Effect.exit(
      searchTextFilesEffect({
        paths: ["first"],
        query: "match",
        caseSensitive: true,
        start: { file: 0, line: 0 },
        readBytes: () => Effect.die(defect),
      }),
    );
    assertTrue(Exit.hasDies(exit));
    expect(Cause.squash(exit.cause)).toBe(defect);
  }),
);
