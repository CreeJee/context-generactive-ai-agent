import { it } from "@effect/vitest";
import type { AnyTool } from "@tanstack/ai";
import { Effect, Layer } from "effect";
import { describe, expect } from "vite-plus/test";
import type { Project } from "../../src/projects/projects.ts";
import { makeLazyTools } from "../../src/tools/discovery.ts";
import { FileTools } from "../../src/tools/files.ts";
import type { RunTool } from "../../src/tools/run-tool.ts";
import { withTestPlatform } from "../support/platform.ts";
import { compatibleToolRequestDifference, toolRequestDifferences } from "../support/requests.ts";
import { inRun } from "../support/run-span.ts";

/**
 * Each tool set's Effect AI tools reach the providers as its TanStack tools did
 * (docs/effect-ai-migration.md step 3): names, descriptions, parameters and lazy listing.
 */

const project: Project = {
  id: "p1",
  root: "/tmp/project",
  name: "project",
  crossRecallExcluded: false,
  permissionMode: "ask",
  createdAt: "2026-09-14T00:00:00.000Z",
  hiddenAt: null,
};

/** Where the requests first differ: anthropic, openai, then the compatible endpoint. */
const requestDifferences = (chatTools: ReadonlyArray<AnyTool>, runTools: ReadonlyArray<RunTool>) =>
  Effect.gen(function* () {
    const lazyTools = yield* makeLazyTools(runTools, []);
    const modelTools = (yield* lazyTools.offered).map((tool) => tool.tool);
    const subscription = yield* toolRequestDifferences({ chatTools, modelTools });
    return [
      ...subscription.map(({ difference }) => difference),
      yield* compatibleToolRequestDifference({ chatTools, modelTools }),
    ];
  });

const same = [undefined, undefined, undefined];

describe("Effect AI tools", () => {
  it.live("file tools", () =>
    withTestPlatform(
      Effect.gen(function* () {
        const files = yield* Effect.provideContext(FileTools, yield* Layer.build(FileTools.layer));
        expect(
          yield* requestDifferences(
            yield* inRun(files.forProject(project)),
            files.runToolsFor(project),
          ),
        ).toEqual(same);
      }),
    ),
  );
});
