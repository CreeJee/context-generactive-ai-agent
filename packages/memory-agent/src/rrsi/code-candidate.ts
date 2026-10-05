import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CodeProposal } from "./contracts.ts";

const run = promisify(execFile);
export const editableCode = [
  "packages/memory-agent/src/agent/prompt-layout.ts",
  "packages/memory-agent/src/agent/compaction.ts",
  "packages/memory-agent/src/agent/full-loop-worker.ts",
  "packages/memory-agent/src/tools/memory.ts",
  "packages/memory-agent/src/memory/search.ts",
] as const;
export function codeContext(repository: string) {
  return editableCode.map((path) => ({
    path,
    source: readFileSync(join(repository, path), "utf8").slice(0, 15000),
  }));
}
export function applyCodeProposal(directory: string, proposal: CodeProposal) {
  if (
    proposal.files.length < 1 ||
    proposal.files.length > 3 ||
    proposal.edits.length < 1 ||
    proposal.edits.length > 3
  )
    throw new Error("code_edit_budget");
  const root = realpathSync(directory);
  const replacements = new Map<string, string>();
  for (const edit of proposal.files) {
    if (!editableCode.some((path) => path === edit.path)) throw new Error("protected_code_path");
    const file = join(root, edit.path);
    if (realpathSync(file) !== file) throw new Error("code_symlink_rejected");
    const source = replacements.get(file) ?? readFileSync(file, "utf8");
    if (
      source.indexOf(edit.before) < 0 ||
      source.indexOf(edit.before) !== source.lastIndexOf(edit.before)
    )
      throw new Error("code_anchor_ambiguous");
    replacements.set(file, source.replace(edit.before, edit.after));
  }
  for (const [file, source] of replacements) writeFileSync(file, source);
}
export async function prepareCodeCandidate(
  repository: string,
  experimentId: string,
  proposal: CodeProposal,
  signal: AbortSignal,
) {
  const branch = `rrsi/${experimentId}/code`;
  const directory = join(repository, ".rrsi-local/candidates", experimentId, "code");
  mkdirSync(join(repository, ".rrsi-local/candidates", experimentId), { recursive: true });
  await run("git", ["worktree", "add", "-b", branch, directory, "HEAD"], {
    cwd: repository,
    signal,
  });
  applyCodeProposal(directory, proposal);
  const { stdout: diff } = await run("git", ["diff", "--", ...editableCode], {
    cwd: directory,
    signal,
  });
  if (!diff) throw new Error("empty_code_candidate");
  await run("git", ["add", "--", ...editableCode], { cwd: directory, signal });
  await run(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      "experiment: propose harness code improvement",
    ],
    { cwd: directory, signal },
  );
  const { stdout: commit } = await run("git", ["rev-parse", "HEAD"], { cwd: directory, signal });
  const tag = `context-agent-rrsi:code-${createHash("sha256").update(commit).digest("hex").slice(0, 16)}`;
  // Dockerfile/dependencies/evaluator are protected; no candidate command executes on the host.
  await run("docker", ["build", "-f", "tools/rrsi/Dockerfile", "-t", tag, "."], {
    cwd: directory,
    signal,
    maxBuffer: 16 * 1024 * 1024,
  });
  const { stdout: imageId } = await run(
    "docker",
    ["image", "inspect", tag, "--format", "{{.Id}}"],
    { signal },
  );
  const image = imageId.trim();
  await run(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "256",
      "--memory",
      "3g",
      "--cpus",
      "2",
      "--tmpfs",
      "/tmp:rw,nosuid,size=1g,mode=1777",
      "--entrypoint",
      "sh",
      image,
      "-c",
      "pnpm exec vp check packages/memory-agent/src packages/memory-agent/eval && pnpm exec tsc -p packages/memory-agent/tsconfig.json --incremental false --composite false && pnpm exec vp test --run packages/memory-agent/tests/compaction.test.ts packages/memory-agent/tests/memory-tool-factory.test.ts packages/memory-agent/tests/full-loop-execution.test.ts --maxWorkers=1",
    ],
    { signal, maxBuffer: 16 * 1024 * 1024 },
  );
  return { branch, commit: commit.trim(), diff, image };
}
