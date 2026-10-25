---
name: git-diff-paths
description: "Prints the unstaged and staged git diff of the given paths (capped at 400 lines). Use before committing to check exactly what will go into a commit, especially when other sessions' edits may share the same files."
---

Arguments are paths relative to the repository root. Shows unstaged then staged diffs, each capped at 400 lines.

Run with the `run_skill` tool (name `git-diff-paths`). The script is `scripts/run.sh`; arguments arrive as `$1`, `$2`, ….
