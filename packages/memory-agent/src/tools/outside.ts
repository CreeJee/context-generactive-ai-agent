import { Cause } from "effect";
import { isTruthy } from "../truthy.ts";
import { toolDefinition } from "@tanstack/ai";
import { Context, Effect, Layer, Schema } from "effect";
import { StorageRoot } from "../config/storage-root.ts";
import { listOutsideFilesEffect, createSnapshots } from "../files/listing.ts";
import { resolveFencedOutsidePath, type Fenced } from "../files/paths.ts";
import { decodeSearchCursor, encodeSearchCursor, searchTextFilesEffect } from "../files/search.ts";
import { createTextPageReader, readFileBytesEffect } from "../files/text.ts";
import type { Project } from "../projects/projects.ts";
import { runNativeEffectWith } from "../runtime/native-effect.ts";
import { runTrace } from "../runtime/run-trace.ts";
import { guardedEffect } from "./failure.ts";
import { listPageSize } from "./files.ts";
import { lazily } from "./lazy.ts";
import { runTool } from "./run-tool.ts";
import { definitionOf } from "./schema.ts";

export const outsideReadToolNames = [
  "list_outside_files",
  "read_outside_file",
  "search_outside_file",
] as const;

const absolutePath = (description: string) => Schema.String.annotate({ description });

const listOutsideInput = Schema.Struct({
  directory: absolutePath("Absolute directory outside the project."),
  glob: Schema.optionalKey(
    Schema.String.annotate({ description: 'Glob relative to the directory, like "**/*.md".' }),
  ),
  snapshot: Schema.optionalKey(
    Schema.String.annotate({ description: "snapshot from the previous page when paging." }),
  ),
  offset: Schema.optionalKey(
    Schema.Int.annotate({ description: "nextOffset from the previous page when paging." }),
  ),
});

const readOutsideInput = Schema.Struct({
  path: absolutePath("Absolute path of a text file outside the project."),
  startLine: Schema.optionalKey(Schema.Int.annotate({ description: "1-based. Defaults to 1." })),
  maxLines: Schema.optionalKey(
    Schema.Int.annotate({ description: "Lines per page, up to 2000. Defaults to 400." }),
  ),
});

const searchOutsideInput = Schema.Struct({
  path: absolutePath("Absolute path of a file, or a directory to search recursively."),
  query: Schema.NonEmptyString.annotate({
    description: "Literal text to find (not a regular expression).",
  }),
  glob: Schema.optionalKey(
    Schema.String.annotate({ description: "When path is a directory, a glob relative to it." }),
  ),
  caseSensitive: Schema.optionalKey(Schema.Boolean.annotate({ description: "Defaults to true." })),
  cursor: Schema.optionalKey(
    Schema.String.annotate({ description: "nextCursor from the previous page when paging." }),
  ),
});

const listOutside = {
  name: "list_outside_files",
  description:
    "List files below a directory outside the project, recursively, without following links. Credential locations are left out. Page with snapshot + nextOffset.",
  parameters: listOutsideInput,
} as const;

const readOutsideFile = {
  name: "read_outside_file",
  description: "Read a text file outside the project by line range. Credential files are refused.",
  parameters: readOutsideInput,
} as const;

const searchOutsideFile = {
  name: "search_outside_file",
  description:
    "Find literal text in a file outside the project, or across a directory outside it, returning matching lines. Page with nextCursor; skipped files are listed.",
  parameters: searchOutsideInput,
} as const;

const make = Effect.gen(function* () {
  const storage = yield* StorageRoot;
  const snapshots = yield* createSnapshots();
  const readPage = createTextPageReader();

  /** The outside tools' calls for `project`, each failing with what the model reads. */
  const callsFor = (project: Fenced<Project>) => {
    // Snapshots are keyed per project so one project's cursors never page another's listing.
    const snapshotKey = `outside:${project.id}`;
    const resolve = (path: string, kind: "file" | "directory") =>
      resolveFencedOutsidePath(project.toolFence, project.root, storage.path, path, kind);
    const readBytes = Effect.fnUntraced(function* (path: string) {
      const resolved = yield* resolveFencedOutsidePath(
        project.toolFence,
        project.root,
        storage.path,
        path,
        "file",
      );
      return (yield* readFileBytesEffect({ absolute: resolved.absolute, path })).bytes;
    });

    return {
      listOutside: ({ directory, glob, snapshot, offset }: typeof listOutsideInput.Type) =>
        guardedEffect(
          directory,
          Effect.gen(function* () {
            let view;
            if (snapshot === undefined) {
              const { absolute } = yield* resolve(directory, "directory");
              view = snapshots.add(
                snapshotKey,
                absolute,
                glob,
                yield* listOutsideFilesEffect(absolute, glob),
              );
            } else view = snapshots.get(snapshot, snapshotKey);
            if (!isTruthy(view))
              return yield* new Cause.UnknownError(
                new Error("snapshot_expired: start again without snapshot and offset."),
              );
            const start = Math.max(0, offset ?? 0);
            const paths = view.paths.slice(start, start + listPageSize);
            const next = start + paths.length;
            return {
              snapshot: view.id,
              directory: view.directory,
              glob: view.glob ?? null,
              total: view.paths.length,
              excludedCredentialFiles: view.excluded,
              truncated: view.truncated,
              paths,
              nextOffset: next < view.paths.length ? next : null,
            };
          }),
        ),

      readOutsideFile: ({ path, startLine, maxLines }: typeof readOutsideInput.Type) =>
        guardedEffect(
          path,
          Effect.gen(function* () {
            const resolved = yield* resolve(path, "file");
            const lines = Math.min(Math.max(1, maxLines ?? 400), 2000);
            return {
              path: resolved.absolute,
              ...(yield* readPage({
                absolute: resolved.absolute,
                path,
                startLine: startLine ?? 1,
                maxLines: lines,
                checkLeaf: true,
              })),
            };
          }),
        ),

      searchOutsideFile: ({
        path,
        query,
        glob,
        caseSensitive = true,
        cursor,
      }: typeof searchOutsideInput.Type) =>
        guardedEffect(
          path,
          Effect.gen(function* () {
            const position = cursor === undefined ? undefined : decodeSearchCursor(cursor);
            if (
              cursor !== undefined &&
              (position?.query !== query || position.caseSensitive !== caseSensitive)
            )
              return yield* new Cause.UnknownError(
                new Error(
                  "invalid_cursor: pass the same query and caseSensitive as the first page.",
                ),
              );

            let view =
              position !== undefined ? snapshots.get(position.snapshot, snapshotKey) : undefined;
            if (!(position !== undefined)) {
              const directory = resolveFencedOutsidePath(
                project.toolFence,
                project.root,
                storage.path,
                path,
                "directory",
              );
              view = yield* directory.pipe(
                Effect.flatMap(({ absolute }) =>
                  listOutsideFilesEffect(absolute, glob).pipe(
                    Effect.map((listing) => snapshots.add(snapshotKey, absolute, glob, listing)),
                  ),
                ),
                Effect.catchTag("PathRejected", (rejection) =>
                  Effect.gen(function* () {
                    if (rejection.reason !== "not_directory") return yield* rejection;
                    const file = yield* resolve(path, "file");
                    return snapshots.add(snapshotKey, file.absolute, undefined, {
                      paths: [file.absolute],
                      source: "walk",
                      excluded: 0,
                      truncated: false,
                    });
                  }),
                ),
              );
            }
            if (!isTruthy(view))
              return yield* new Cause.UnknownError(
                new Error("snapshot_expired: start the search again without cursor."),
              );

            const page = yield* searchTextFilesEffect({
              paths: view.paths,
              readBytes,
              readPage: Effect.fnUntraced(function* (path: string, startLine: number) {
                const resolved = yield* resolve(path, "file");
                return yield* readPage({
                  absolute: resolved.absolute,
                  path,
                  startLine,
                  maxLines: 2000,
                  checkLeaf: true,
                });
              }),
              query,
              caseSensitive,
              start: position ?? { file: 0, line: 0 },
            });
            return {
              filesInView: view.paths.length,
              truncated: view.truncated,
              matches: page.matches,
              skipped: page.skipped,
              nextCursor: isTruthy(page.next)
                ? encodeSearchCursor({ snapshot: view.id, query, caseSensitive, ...page.next })
                : null,
              complete: page.next === null && page.skipped.length === 0 && !view.truncated,
            };
          }),
        ),
    };
  };

  return {
    /**
     * Read-only tools for files outside the project (R04, Q8). They run without approval because
     * reading is allowed everywhere except credentials; results are ordinary tool results, not
     * version-tracked project files. Writing outside the project is a separate, approved tool.
     * They run on the run's context, so their spans join the run's trace.
     */
    forProject: (project: Fenced<Project>) =>
      Effect.map(runTrace, (caller) => {
        const calls = callsFor(project);
        // Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
        const run = runNativeEffectWith(caller);
        return [
          lazily(
            toolDefinition(definitionOf(listOutside)).server((input, context) =>
              run(calls.listOutside(input), { signal: context?.abortSignal }),
            ),
          ),
          lazily(
            toolDefinition(definitionOf(readOutsideFile)).server((input, context) =>
              run(calls.readOutsideFile(input), { signal: context?.abortSignal }),
            ),
          ),
          lazily(
            toolDefinition(definitionOf(searchOutsideFile)).server((input, context) =>
              run(calls.searchOutsideFile(input), { signal: context?.abortSignal }),
            ),
          ),
        ] as const;
      }),

    /** {@link forProject} for the Effect AI loop (docs/effect-ai-migration.md step 3). */
    runToolsFor: (project: Fenced<Project>) => {
      const calls = callsFor(project);
      return [
        runTool({ ...listOutside, lazy: true, handler: calls.listOutside }),
        runTool({ ...readOutsideFile, lazy: true, handler: calls.readOutsideFile }),
        runTool({ ...searchOutsideFile, lazy: true, handler: calls.searchOutsideFile }),
      ];
    },
  };
});

/** Read-only access to files outside the project, credentials excluded. */
export class OutsideTools extends Context.Service<OutsideTools, Effect.Success<typeof make>>()(
  "memory-agent/tools/outside/OutsideTools",
) {
  static readonly layer = Layer.effect(OutsideTools, make);
}
