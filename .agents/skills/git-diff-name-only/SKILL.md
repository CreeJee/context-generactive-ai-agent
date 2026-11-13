---
name: git-diff-name-only
description: "Prints the names of files that differ between two git revisions (uses three-dot diff: changes on the second side since the merge base). Read-only."
---

Arguments: `$1` base revision, `$2` head revision (default HEAD). Runs `git diff --name-status "$1...${2:-HEAD}"`. Read-only; never changes repository state.
