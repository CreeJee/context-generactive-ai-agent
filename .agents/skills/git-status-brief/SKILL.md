---
name: git-status-brief
description: "Prints a one-screen git summary of the working tree: branch and short status, unstaged/staged diff stats, and recent commits. Use before committing, after finishing changes, or when asked what changed in the working tree."
---

The optional argument is how many recent commits to show (default 10). Output is sections: branch & status, unstaged diff stat, staged diff stat, recent commits. Never touches the network or changes repository state.

Run with the `run_skill` tool (name `git-status-brief`). The script is `scripts/run.sh`; arguments arrive as `$1`, `$2`, ….
