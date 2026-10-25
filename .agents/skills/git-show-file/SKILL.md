---
name: git-show-file
description: "Prints a file's content at a git revision (default HEAD). Use to compare or rebuild a working file against the committed version, e.g. when another session committed the same file and only your own edits should be reapplied."
---

First argument: repository-relative path. Second (optional): revision, default HEAD. Prints the file content.

Run with the `run_skill` tool (name `git-show-file`). The script is `scripts/run.sh`; arguments arrive as `$1`, `$2`, ….
