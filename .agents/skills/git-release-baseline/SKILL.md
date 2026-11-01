---
name: git-release-baseline
description: "Prints the repo's remote URL and the highest release tags on it via git ls-remote over https (fallback for gh-release-tag when gh is unauthenticated); pins the S11 compatibility baseline."
---

No arguments. First line: remote URL. Then up to 5 latest semver tags on the remote.

Run with the `run_skill` tool (name `git-release-baseline`). The script is `scripts/run.sh`; arguments arrive as `$1`, `$2`, ….
