---
name: vp-check
description: "Runs `vp check` (format, lint, type check) and prints only errors. Use after editing code, before committing or claiming work is done, or when format/lint/type problems are suspected. Extra arguments are forwarded to `vp check`."
---

No arguments checks the whole repository. Extra arguments are passed to `vp check` verbatim. On success prints `vp check: clean`; on failure prints matching problem lines and the last 40 lines of output, exiting non-zero.

Run with the `run_skill` tool (name `vp-check`). The script is `scripts/run.sh`; arguments arrive as `$1`, `$2`, ….
