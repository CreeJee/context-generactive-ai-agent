import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe, expect } from "vite-plus/test";
import { StorageRoot } from "../../src/config/storage-root.ts";
import type { Project } from "../../src/projects/projects.ts";
import { FileTools } from "../../src/tools/files.ts";
import { OutsideTools } from "../../src/tools/outside.ts";
import { withTestPlatform } from "../support/platform.ts";
import { runToolRequestDifferences } from "../support/requests.ts";
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

const same = [undefined, undefined, undefined];

describe("Effect AI tools", () => {
  it.live("file tools", () =>
    withTestPlatform(
      Effect.gen(function* () {
        const files = yield* Effect.provideContext(FileTools, yield* Layer.build(FileTools.layer));
        expect(
          yield* runToolRequestDifferences({
            chatTools: yield* inRun(files.forProject(project)),
            runTools: files.runToolsFor(project),
          }),
        ).toEqual(same);
      }),
    ),
  );

  it.live("outside tools", () =>
    withTestPlatform(
      Effect.gen(function* () {
        const outside = yield* Effect.provideContext(
          OutsideTools,
          yield* Layer.build(
            OutsideTools.layer.pipe(Layer.provide(StorageRoot.layer("/tmp/storage"))),
          ),
        );
        expect(
          yield* runToolRequestDifferences({
            chatTools: yield* inRun(outside.forProject(project)),
            runTools: outside.runToolsFor(project),
          }),
        ).toEqual(same);
      }),
    ),
  );
});
