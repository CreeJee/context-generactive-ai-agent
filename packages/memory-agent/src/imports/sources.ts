import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
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
  readonly transcripts: (root: string) => readonly Transcript[];
  readonly reader: (transcriptId: string) => TranscriptReader;
}

/** Files directly inside `directory`, or [] when it does not exist. */
function entries(directory: string) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Every `.jsonl` at any depth under `root`, oldest path first for a stable order. */
function transcriptFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of entries(directory).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".jsonl")) found.push(path);
    }
  };
  walk(root);
  return found;
}

/** `rollout-2026-09-15T10-16-44-<uuid>.jsonl` → the uuid. */
const codexTranscriptId = (path: string) => {
  const name = basename(path, ".jsonl");
  const uuid =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.exec(name)?.[0] ?? null;
  return uuid ?? name;
};

const claudeCode: ImportSource = {
  name: "claude-code",
  root: (home) => join(home, ".claude", "projects"),
  transcripts: (root) =>
    transcriptFiles(root).map((path) => ({
      source: "claude-code",
      path,
      externalId: basename(path, ".jsonl"),
    })),
  // Claude Code lines carry their own ids, so the file name is not needed to make them unique.
  reader: () => readClaudeCodeLine,
};

const codex: ImportSource = {
  name: "codex",
  root: (home) => join(home, ".codex", "sessions"),
  transcripts: (root) =>
    transcriptFiles(root)
      .filter((path) => basename(path).startsWith("rollout-"))
      .map((path) => ({ source: "codex", path, externalId: codexTranscriptId(path) })),
  reader: codexReader,
};

/** Every coding agent this app can migrate transcripts from. */
export const importSources: readonly ImportSource[] = [claudeCode, codex];

/** The transcripts of every source, from the user's home directory. */
export function findTranscripts(home: string = homedir()): readonly Transcript[] {
  return importSources.flatMap((source) => source.transcripts(source.root(home)));
}
