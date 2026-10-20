---
name: test-failures
description: "Runs the monorepo test suite (`vp run -r test`) and prints only failing tests with their assertion output. Use after changing code, before claiming a change works, when the user asks whether tests pass, or to re-check a failing suite. Extra arguments are forwarded to `vp run -r test` (e.g. `agent#test` to run one package)."
---

No arguments runs the whole suite. Extra arguments are passed to `vp run -r test` verbatim (for example `agent#test`). On success prints a one-line pass note and the vitest summary; on failure prints failing test lines and the last 60 lines of output, exiting non-zero.

Run with the `run_skill` tool (name `test-failures`). The script is `scripts/run.sh`; arguments arrive as `$1`, `$2`, ….
