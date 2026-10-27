import { Cause } from "effect";
import { isTruthy } from "../truthy.ts";
import { Context, Crypto, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { StorageRoot } from "../config/storage-root.ts";
import { listOutsideFilesEffect, createSnapshots, type Snapshot } from "../files/listing.ts";
import { resolveFencedOutsidePath, type Fenced } from "../files/paths.ts";
import { decodeSearchCursor, encodeSearchCursor, searchTextFilesEffect } from "../files/search.ts";
import { createTextPageReader, readFileBytesEffect } from "../files/text.ts";
import type { Project } from "../projects/projects.ts";
import { guardedEffect } from "./failure.ts";
import { listPageSize } from "./files.ts";
import { runTool } from "./run-tool.ts";

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
  const platform = yield* Effect.context<FileSystem.FileSystem | Crypto.Crypto>();

  /** The listing `lookup` finds, failing with `expired` when its snapshot is gone. */
  const unexpired = <E, R>(lookup: Effect.Effect<Snapshot | undefined, E, R>, expired: string) =>
    Effect.flatMap(lookup, (found) =>
      Effect.fromOption(
        Option.liftPredicate(found, isTruthy),
        () => new Cause.UnknownError(new Error(expired)),
      ),
    );

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
            const view = yield* unexpired(
              Option.match(Option.fromNullishOr(snapshot), {
                onNone: () =>
                  Effect.flatMap(resolve(directory, "directory"), ({ absolute }) =>
                    Effect.flatMap(listOutsideFilesEffect(absolute, glob), (listing) =>
                      snapshots.add(snapshotKey, absolute, glob, listing),
                    ),
                  ),
                onSome: (id) => snapshots.get(id, snapshotKey),
              }),
              "snapshot_expired: start again without snapshot and offset.",
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
          }).pipe(Effect.provideContext(platform)),
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
          }).pipe(Effect.provideContext(platform)),
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
            // A cursor continues only the search that made it.
            const position = yield* Effect.succeed(
              Option.flatMapNullishOr(Option.fromNullishOr(cursor), decodeSearchCursor),
            ).pipe(
              Effect.filterOrFail(
                (decoded) =>
                  cursor === undefined ||
                  Option.exists(
                    decoded,
                    (at) => at.query === query && at.caseSensitive === caseSensitive,
                  ),
                () =>
                  new Cause.UnknownError(
                    new Error(
                      "invalid_cursor: pass the same query and caseSensitive as the first page.",
                    ),
                  ),
              ),
            );

            // A new search lists the directory, or searches the one file `path` names.
            const listed = resolveFencedOutsidePath(
              project.toolFence,
              project.root,
              storage.path,
              path,
              "directory",
            ).pipe(
              Effect.flatMap(({ absolute }) =>
                listOutsideFilesEffect(absolute, glob).pipe(
                  Effect.flatMap((listing) => snapshots.add(snapshotKey, absolute, glob, listing)),
                ),
              ),
              Effect.catchTag("PathRejected", (rejection) =>
                rejection.reason === "not_directory"
                  ? Effect.flatMap(resolve(path, "file"), (file) =>
                      snapshots.add(snapshotKey, file.absolute, undefined, {
                        paths: [file.absolute],
                        source: "walk",
                        excluded: 0,
                        truncated: false,
                      }),
                    )
                  : Effect.fail(rejection),
              ),
            );
            const view = yield* unexpired(
              Option.match(position, {
                onNone: () => listed,
                onSome: (at) => snapshots.get(at.snapshot, snapshotKey),
              }),
              "snapshot_expired: start the search again without cursor.",
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
              start: Option.getOrElse(position, () => ({ file: 0, line: 0 })),
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
          }).pipe(Effect.provideContext(platform)),
        ),
    };
  };

  return {
    /**
     * Read-only tools for files outside the project (R04, Q8). They run without approval because
     * reading is allowed everywhere except credentials; results are ordinary tool results, not
     * version-tracked project files. Writing outside the project is a separate, approved tool.
     * They run on the loop's fiber, so their spans join the run's trace.
     */
    toolsFor: (project: Fenced<Project>) => {
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
