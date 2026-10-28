import { Effect, FileSystem, Option } from "effect";
// Native host/SDK boundary uses Node types, protocols or synchronous SQLite/filesystem contracts.
import { path as platformPath } from "../runtime/synchronous-path.ts";
const { basename, join } = platformPath;
import { readClaudeCodeLine } from "./claude-code.ts";
import { codexReader } from "./codex.ts";
import type { ImportSourceName, TranscriptReader } from "./items.ts";

/** One transcript file of one conversation, as found on disk. */
export interface Transcript {
  readonly source: ImportSourceName;
  readonly path: string;
  /** The other tool's conversation id, taken from the file name. */
  readonly externalId: string;
  /** The other tool moved this conversation out of its list; the session follows the first time. */
  readonly archived: boolean;
}

export interface ImportSource {
  readonly name: ImportSourceName;
  /** Where that tool keeps its transcripts. */
  readonly root: (home: string) => string;
  readonly transcripts: (
    root: string,
  ) => Effect.Effect<readonly Transcript[], never, FileSystem.FileSystem>;
  readonly reader: (transcriptId: string) => TranscriptReader;
}

/** Every file ending in one of `suffixes` at any depth under `root`, oldest path first for a stable
 * order. Symbolic-link directories are not followed, matching the prior Dirent contract. */
const transcriptFiles = Effect.fn("transcriptFiles")(function* (
  root: string,
  suffixes: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const walk = (directory: string): Effect.Effect<readonly string[]> =>
    Effect.gen(function* () {
      // An unreadable directory or entry is skipped, and a link is not followed.
      const entries = yield* fs
        .readDirectory(directory)
        .pipe(Effect.catchTag("PlatformError", () => Effect.succeed([])));
      const found = yield* Effect.forEach(
        entries.sort((a, b) => a.localeCompare(b)),
        (name) =>
          Effect.gen(function* () {
            const path = join(directory, name);
            const link = yield* fs.readLink(path).pipe(
              Effect.asSome,
              Effect.catchTag("PlatformError", () => Effect.succeedNone),
            );
            const stats = Option.isSome(link)
              ? undefined
              : yield* fs.stat(path).pipe(Effect.catchTag("PlatformError", () => Effect.void));
            if (stats?.type === "Directory") return yield* walk(path);
            return suffixes.some((suffix) => name.endsWith(suffix)) ? [path] : [];
          }),
      );
      return found.flat();
    });
  return yield* walk(root);
});

/** Codex compresses rollouts it no longer appends to; the conversation keeps its id. */
const codexSuffixes = [".jsonl", ".jsonl.zst"];

/** `rollout-2026-09-15T10-16-44-<uuid>.jsonl` or `….jsonl.zst` → the uuid. */
const codexTranscriptId = (path: string) => {
  const name = basename(path).replace(/\.jsonl(?:\.zst)?$/u, "");
  const uuid =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.exec(name)?.[0] ?? null;
  return uuid ?? name;
};

const claudeCode: ImportSource = {
  name: "claude-code",
  root: (home) => join(home, ".claude", "projects"),
  transcripts: (root) =>
    transcriptFiles(root, [".jsonl"]).pipe(
      Effect.map((paths) =>
        paths.map((path) => ({
          source: "claude-code",
          path,
          externalId: basename(path, ".jsonl"),
          archived: false,
        })),
      ),
    ),
  // Claude Code lines carry their own ids, so the file name is not needed to make them unique.
  reader: () => readClaudeCodeLine,
};

/** Codex moves an archived conversation's rollout from `sessions` to `archived_sessions`. */
const codexFolders = [
  { name: "sessions", archived: false },
  { name: "archived_sessions", archived: true },
] as const;

const codex: ImportSource = {
  name: "codex",
  root: (home) => join(home, ".codex"),
  transcripts: (root) =>
    Effect.forEach(codexFolders, (folder) =>
      transcriptFiles(join(root, folder.name), codexSuffixes).pipe(
        Effect.map((paths) =>
          paths
            .filter((path) => basename(path).startsWith("rollout-"))
            .map((path) => ({
              source: "codex" as const,
              path,
              externalId: codexTranscriptId(path),
              archived: folder.archived,
            })),
        ),
      ),
    ).pipe(Effect.map((found) => found.flat())),
  reader: codexReader,
};

/** Every coding agent this app can migrate transcripts from. */
export const importSources: readonly ImportSource[] = [claudeCode, codex];

/** The transcripts of every source under the explicitly selected home. */
export const findTranscripts = Effect.fn("findTranscripts")(function* (home: string) {
  const found = yield* Effect.forEach(importSources, (source) =>
    source.transcripts(source.root(home)),
  );
  return found.flat();
});
