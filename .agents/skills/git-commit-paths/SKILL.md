---
name: git-commit-paths
description: "Stages exactly the given paths and commits them with the given message, leaving every other change in the working tree untouched. Use when the user asks to commit work you did, especially when unrelated user edits are also in the tree."
---

First argument: commit message. Remaining arguments: paths to stage and commit (only these are committed). Prints git's commit output and the new commit line.

Run with the `run_skill` tool (name `git-commit-paths`). The script is `scripts/run.sh`; arguments arrive as `$1`, `$2`, ….
