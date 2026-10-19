import { nativePromise, runNativeEffect } from "../runtime/native-effect.ts";
import { Cause, Effect, Function as EffectFunction } from "effect";
import { MutableHashMap, Option } from "effect";
import { isTruthy } from "../truthy.ts";
import { oauthProtocolCrypto } from "../oauth/node-runtime.ts";
import { oauthProtocolFileSystem as fs } from "../oauth/node-runtime.ts";
import { oauthProtocolPath } from "../oauth/node-runtime.ts";
import { runProcess } from "./command.ts";
const run = (
  command: string,
  args: readonly string[],
  options: Omit<Parameters<typeof runProcess>[0], "command" | "args"> = {},
) => runProcess({ command, args, ...options });
import type { CodeProposal } from "./contracts.ts";

export const editableCode = [
  "packages/memory-agent/src/agent/prompt-layout.ts",
  "packages/memory-agent/src/agent/compaction.ts",
  "packages/memory-agent/src/agent/full-loop-worker.ts",
  "packages/memory-agent/src/tools/memory.ts",
  "packages/memory-agent/src/memory/search.ts",
] as const;
export const codeContext = Effect.fnUntraced(function* (repository: string) {
  return yield* Effect.forEach(editableCode, (path) =>
    fs
      .readFileString(oauthProtocolPath.join(repository, path))
      .pipe(Effect.map((source) => ({ path, source: source.slice(0, 15000) }))),
  );
});

export const applyCodeProposal: {
  (proposal: CodeProposal): (directory: string) => ReturnType<typeof applyCodeProposalBody>;
} & typeof applyCodeProposalBody = EffectFunction.dual(2, applyCodeProposalBody);
function applyCodeProposalBody(directory: string, proposal: CodeProposal) {
  return Effect.gen(function* () {
    if (
      proposal.files.length < 1 ||
      proposal.files.length > 3 ||
      proposal.edits.length < 1 ||
      proposal.edits.length > 3
    )
      return yield* new Cause.UnknownError(new Error("code_edit_budget"));
    const root = yield* fs.realPath(directory);
    const replacements = MutableHashMap.empty<string, string>();
    for (const edit of proposal.files) {
      if (!editableCode.some((path) => path === edit.path))
        return yield* new Cause.UnknownError(new Error("protected_code_path"));
      const file = oauthProtocolPath.join(root, edit.path);
      if ((yield* fs.realPath(file)) !== file)
        return yield* new Cause.UnknownError(new Error("code_symlink_rejected"));
      const source =
        Option.getOrUndefined(MutableHashMap.get(replacements, file)) ??
        (yield* fs.readFileString(file));
      if (
        source.indexOf(edit.before) < 0 ||
        source.indexOf(edit.before) !== source.lastIndexOf(edit.before)
      )
        return yield* new Cause.UnknownError(new Error("code_anchor_ambiguous"));
      MutableHashMap.set(replacements, file, source.replace(edit.before, edit.after));
    }
    for (const [file, source] of replacements) yield* fs.writeFileString(file, source);
  });
}
// Promise/async-iterator boundary for the native SDK caller; domain Effects run in the caller runtime.
export const prepareCodeCandidate: {
  (
    experimentId: string,
    proposal: CodeProposal,
    signal: AbortSignal,
  ): (repository: string) => ReturnType<typeof prepareCodeCandidateBody>;
} & typeof prepareCodeCandidateBody = EffectFunction.dual(4, prepareCodeCandidateBody);
function prepareCodeCandidateBody(
  repository: string,
  experimentId: string,
  proposal: CodeProposal,
  signal: AbortSignal,
) {
  return runNativeEffect(
    Effect.gen(function* () {
      const branch = `rrsi/${experimentId}/code`;
      const directory = oauthProtocolPath.join(
        repository,
        ".rrsi-local/candidates",
        experimentId,
        "code",
      );
      yield* fs.makeDirectory(
        oauthProtocolPath.join(repository, ".rrsi-local/candidates", experimentId),
        {
          recursive: true,
        },
      );
      yield* nativePromise(() =>
        run("git", ["worktree", "add", "-b", branch, directory, "HEAD"], {
          cwd: repository,
          signal,
        }),
      );
      yield* applyCodeProposal(directory, proposal);
      const { stdout: diff } = yield* nativePromise(() =>
        run("git", ["diff", "--", ...editableCode], {
          cwd: directory,
          signal,
        }),
      );
      if (!isTruthy(diff)) return yield* new Cause.UnknownError(new Error("empty_code_candidate"));
      yield* nativePromise(() =>
        run("git", ["add", "--", ...editableCode], { cwd: directory, signal }),
      );
      yield* nativePromise(() =>
        run(
          "git",
          [
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "-m",
            "experiment: propose harness code improvement",
          ],
          { cwd: directory, signal },
        ),
      );
      const { stdout: commit } = yield* nativePromise(() =>
        run("git", ["rev-parse", "HEAD"], { cwd: directory, signal }),
      );
      const tag = `context-agent-rrsi:code-${Buffer.from(
        yield* oauthProtocolCrypto.digest("SHA-256", new TextEncoder().encode(commit)),
      )
        .toString("hex")
        .slice(0, 16)}`;
      // Dockerfile/dependencies/evaluator are protected; no candidate command executes on the host.
      yield* nativePromise(() =>
        run("docker", ["build", "-f", "tools/rrsi/Dockerfile", "-t", tag, "."], {
          cwd: directory,
          signal,
          maxBuffer: 16 * 1024 * 1024,
        }),
      );
      const { stdout: imageId } = yield* nativePromise(() =>
        run("docker", ["image", "inspect", tag, "--format", "{{.Id}}"], { signal }),
      );
      const image = imageId.trim();
      yield* nativePromise(() =>
        run(
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
        ),
      );
      return { branch, commit: commit.trim(), diff, image };
    }),
  );
}
