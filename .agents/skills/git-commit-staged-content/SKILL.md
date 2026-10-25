---
name: git-commit-staged-content
description: "Commits a given file content for one path without touching the working tree: stores the content file as the path's index entry and commits only that path. Use when a working file mixes your edits with another session's uncommitted edits and only yours (rebuilt on HEAD) should be committed."
---

Arguments: commit message, repository-relative path, and a file (inside the project) holding the exact content to commit for that path. Refuses if anything else is already staged. The working tree file is left as it is.

Run with the `run_skill` tool (name `git-commit-staged-content`). The script is `scripts/run.sh`; arguments arrive as `$1`, `$2`, ….
