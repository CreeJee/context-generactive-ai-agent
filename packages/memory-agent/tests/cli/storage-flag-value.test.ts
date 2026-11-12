import { NodeServices } from "@effect/platform-node";
import { Effect, Option } from "effect";
import { layer } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { storageFlagValue } from "../../src/cli/commands.ts";

// `storageFlagValue` reads the `--storage` value out of raw arguments before effect/cli parses them, so the
// executable's entry can decide the runtime root first. Its token forms must stay in step with the lexer and
// parser (`--storage <value>`, `--storage=<value>`, nothing after `--`, one occurrence at most), which types
// cannot confirm.
layer(NodeServices.layer)((it) => {
  it.effect("reads --storage after the subcommand", () =>
    Effect.sync(() => {
      expect(
        Option.getOrUndefined(storageFlagValue(["find-memory", "--storage", "/x", "query"])),
      ).toBe("/x");
    }),
  );
  it.effect("reads --storage before the subcommand", () =>
    Effect.sync(() => {
      expect(Option.getOrUndefined(storageFlagValue(["--storage", "/y", "find-memory"]))).toBe(
        "/y",
      );
    }),
  );
  it.effect("reads the inline form", () =>
    Effect.sync(() => {
      expect(Option.getOrUndefined(storageFlagValue(["find-memory", "--storage=/z"]))).toBe("/z");
    }),
  );
  it.effect("keeps the first of two occurrences", () =>
    Effect.sync(() => {
      expect(
        Option.getOrUndefined(
          storageFlagValue(["find-memory", "--storage", "/a", "--storage", "/b"]),
        ),
      ).toBe("/a");
    }),
  );
  it.effect("ignores a valueless flag", () =>
    Effect.sync(() => {
      expect(storageFlagValue(["find-memory", "--storage"])).toStrictEqual(Option.none());
    }),
  );
  it.effect("ignores a flag-like value the parser would refuse", () =>
    Effect.sync(() => {
      expect(storageFlagValue(["find-memory", "--storage", "--limit"])).toStrictEqual(
        Option.none(),
      );
    }),
  );
  it.effect("stops at --", () =>
    Effect.sync(() => {
      expect(storageFlagValue(["find-memory", "--", "--storage", "/after"])).toStrictEqual(
        Option.none(),
      );
    }),
  );
  it.effect("keeps an empty inline value", () =>
    Effect.sync(() => {
      expect(Option.getOrUndefined(storageFlagValue(["find-memory", "--storage="]))).toBe("");
    }),
  );
});
