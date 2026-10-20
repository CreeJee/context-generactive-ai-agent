---
name: package-smoke
description: "Builds the current-device executable (`vp run package` in apps/agent) and runs its smoke check (`vp run smoke-package`). Use when verifying the packaged app after build-related or release-related changes, or when the user asks to check the executable."
---

Takes no arguments. Prints packaging progress capped to the tail on failure; the smoke check output decides the final exit status (non-zero means the packaged app failed its smoke test).

Run with the `run_skill` tool (name `package-smoke`). The script is `scripts/run.sh`; arguments arrive as `$1`, `$2`, ….
