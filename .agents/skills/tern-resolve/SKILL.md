---
name: tern-resolve
description: "Record settled Tern check findings (tern checks resolve) when the tern CLI is not on PATH"
---

Args: finding ids to settle. Env TERN_ARGS must hold the resolve flags. With no args prints the checks list. Run from the repo root.

Run with the `run_skill` tool (name `tern-resolve`). The script is `scripts/run.sh`; arguments arrive as `$1`, `$2`, ….
