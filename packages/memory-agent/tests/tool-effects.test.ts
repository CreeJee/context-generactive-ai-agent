import { HashSet, Effect, FileSystem, Layer, Path } from "effect";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { layer } from "@effect/vitest";
import { test, expect } from "vite-plus/test";
import { approvalToolDefinitions } from "../src/tools/definitions.ts";
import { delegateToolName } from "../src/tools/delegate.ts";
import { builtinToolEffects, readOnlyToolNames } from "../src/tools/effects.ts";

const unclassified = (names: readonly string[]) =>
  names.filter((name) => !Object.hasOwn(builtinToolEffects, name));

layer(Layer.merge(NodeFileSystem.layer, NodePath.layer))((it) => {
  it.effect("every built-in source registration requires an explicit owner effect decision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* (yield* Path.Path).fromFileUrl(new URL("../src/", import.meta.url));
      const registered = new Set<string>([
        ...approvalToolDefinitions.map((tool) => tool.name),
        delegateToolName,
      ]);
      for (const entry of yield* fs.readDirectory(root, { recursive: true })) {
        const path = String(entry);
        if (!path.endsWith(".ts")) continue;
        const source = yield* fs.readFileString(`${root}/${path}`);
        // Guard the current registration syntax, including new files. Unrecognized declarations
        // fail for manual review rather than silently defaulting a new built-in to either policy.
        for (const call of source.matchAll(/toolDefinition\(\s*\{([\s\S]*?)\}\s*\)/g)) {
          const literal = /\bname:\s*["']([^"']+)["']/.exec(call[1])?.[1];
          if (literal !== undefined) {
            registered.add(literal);
            continue;
          }
          switch (String(path)) {
            case "tools/definitions.ts":
              expect(call[1]).toMatch(/\.\.\.(saveCodeSkill|writeOutsideFile|deleteOutsideFile)\b/);
              break;
            case "tools/delegate.ts":
              expect(call[1]).toMatch(/name:\s*delegateToolName\b/);
              break;
            default:
              throw new Error(
                `Unrecognized tool registration in ${path}; declare its owner effect contract`,
              );
          }
        }
        // A tool that TanStack and Effect AI share names itself in a spec with its parameters.
        for (const spec of source.matchAll(
          /\bname:\s*["']([^"']+)["'],\s*description:[^{}]*?\bparameters:/g,
        ))
          registered.add(spec[1]);
      }
      expect(unclassified([...registered])).toEqual([]);
      expect(Object.keys(builtinToolEffects).filter((name) => !registered.has(name))).toEqual([]);
      expect(unclassified([...registered, "new_unclassified_tool"])).toEqual([
        "new_unclassified_tool",
      ]);
    }),
  );
});

test("acknowledgements, durable writes, billable and unknown tools are never settled as pure reads", () => {
  for (const name of [
    "find_memory",
    "kagi_search",
    "kagi_extract",
    "cancel_background_task",
    "adopt_subagent_reports",
    "use_promoted_memory",
    "mcp_server__read_sounding_tool",
    "new_tool",
  ])
    expect(HashSet.has(readOnlyToolNames, name)).toBe(false);
  for (const name of [
    "get_background_result",
    "get_subagent_report",
    "get_subagent_reports",
    "wait_subagents",
    "list_report_evidence",
    "read_report_item",
  ])
    expect(HashSet.has(readOnlyToolNames, name)).toBe(true);
});
