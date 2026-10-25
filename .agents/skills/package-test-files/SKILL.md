---
name: package-test-files
description: "Runs only the given test files (or vitest filters) of one workspace package and prints failing tests with their output, or a pass summary. Use after changing a module to check its own unit and feature tests quickly, instead of the whole monorepo suite; set workdir to the package (e.g. packages/memory-agent)."
---

Set workdir to the package (packages/memory-agent, apps/agent). Arguments are test file paths relative to it or vitest name filters. Prints a pass summary, or failing tests and the last 80 lines; exits non-zero on failure.

Run with the `run_skill` tool (name `package-test-files`). The script is `scripts/run.sh`; arguments arrive as `$1`, `$2`, ….
