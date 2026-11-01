---
name: gh-release-tag
description: "Prints the repo's latest published (non-draft) GitHub release tag via gh with a scratch GH_CONFIG_DIR inside the project (sandbox-writable); used to pin the backward-compatibility baseline (S11)."
---

No arguments. Prints the tag name (e.g. v1.2.3) or nothing if there is no release.

Run with the `run_skill` tool (name `gh-release-tag`). The script is `scripts/run.sh`; arguments arrive as `$1`, `$2`, ….
