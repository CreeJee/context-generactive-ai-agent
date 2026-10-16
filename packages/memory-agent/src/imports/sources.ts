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
  const found: string[] = [];
  const walk = (directory: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const entries = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
      for (const name of entries.sort((a, b) => a.localeCompare(b))) {
        const path = join(directory, name);
        const link = yield* fs.readLink(path).pipe(Effect.option);
        const stats = Option.isSome(link)
          ? undefined
          : yield* fs.stat(path).pipe(Effect.orElseSucceed(() => undefined));
        if (stats?.type === "Directory") yield* walk(path);
        else if (suffixes.some((suffix) => name.endsWith(suffix))) found.push(path);
      }
    });
  yield* walk(root);
  return found;
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
        })),
      ),
    ),
  // Claude Code lines carry their own ids, so the file name is not needed to make them unique.
  reader: () => readClaudeCodeLine,
};

const codex: ImportSource = {
  name: "codex",
  root: (home) => join(home, ".codex", "sessions"),
  transcripts: (root) =>
    transcriptFiles(root, codexSuffixes).pipe(
      Effect.map((paths) =>
        paths
          .filter((path) => basename(path).startsWith("rollout-"))
          .map((path) => ({ source: "codex", path, externalId: codexTranscriptId(path) })),
      ),
    ),
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
