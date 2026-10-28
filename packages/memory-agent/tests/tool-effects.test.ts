import { HashSet, Effect, FileSystem, Layer, Path } from "effect";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { layer } from "@effect/vitest";
import { test, expect } from "vite-plus/test";
import { gatedToolNames } from "../src/tools/definitions.ts";
import { delegateToolName } from "../src/tools/delegate.ts";
import { builtinToolEffects, readOnlyToolNames } from "../src/tools/effects.ts";

const unclassified = (names: readonly string[]) =>
  names.filter((name) => !Object.hasOwn(builtinToolEffects, name));

/** The name a `toolDefinition({ ... })` call in `path` registers by literal, if any. */
const definitionNames = (path: string, body: string): ReadonlyArray<string> => {
  const literal = /\bname:\s*["']([^"']+)["']/.exec(body)?.[1];
  if (literal !== undefined) return [literal];
  switch (path) {
    case "tools/delegate.ts":
      expect(body).toMatch(/name:\s*delegateToolName\b/);
      return [];
    default:
      throw new Error(
        `Unrecognized tool registration in ${path}; declare its owner effect contract`,
      );
  }
};

layer(Layer.merge(NodeFileSystem.layer, NodePath.layer))((it) => {
  it.effect("every built-in source registration requires an explicit owner effect decision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* (yield* Path.Path).fromFileUrl(new URL("../src/", import.meta.url));
      const sources = yield* Effect.forEach(
        (yield* fs.readDirectory(root, { recursive: true }))
          .map(String)
          .filter((path) => path.endsWith(".ts")),
        (path) => Effect.map(fs.readFileString(`${root}/${path}`), (source) => ({ path, source })),
      );
      const registered = new Set<string>([
        ...gatedToolNames,
        delegateToolName,
        ...sources.flatMap(({ path, source }) => [
          // Guard the current registration syntax, including new files. Unrecognized declarations
          // fail for manual review rather than silently defaulting a new built-in to either policy.
          ...Array.from(source.matchAll(/toolDefinition\(\s*\{([\s\S]*?)\}\s*\)/g), (call) =>
            definitionNames(path, call[1]),
          ).flat(),
          // A tool that TanStack and Effect AI share names itself in a spec with its parameters.
          ...Array.from(
            source.matchAll(
              /\bname:\s*["']([^"']+)["'],\s*description:(?:[^{}]|\$\{[^{}]*\})*?\bparameters:/g,
            ),
            (spec) => spec[1],
          ),
        ]),
      ]);
      expect(unclassified([...registered])).toEqual([]);
      expect(Object.keys(builtinToolEffects).filter((name) => !registered.has(name))).toEqual([]);
      expect(unclassified([...registered, "new_unclassified_tool"])).toEqual([
        "new_unclassified_tool",
      ]);
    }),
  );
});

test("acknowledgements, durable writes, billable and unknown tools are never settled as pure reads", () => {
  [
    "find_memory",
    "kagi_search",
    "kagi_extract",
    "cancel_background_task",
    "adopt_subagent_reports",
    "use_promoted_memory",
    "mcp_server__read_sounding_tool",
    "new_tool",
  ].forEach((name) => expect(HashSet.has(readOnlyToolNames, name)).toBe(false));
  [
    "get_background_result",
    "get_subagent_report",
    "get_subagent_reports",
    "wait_subagents",
    "list_report_evidence",
    "read_report_item",
  ].forEach((name) => expect(HashSet.has(readOnlyToolNames, name)).toBe(true));
});
