---
name: agent-test-files
description: "Runs Vitest for specific test files of apps/agent (unit tests with the app's vite config, or *.browser.tsx files with the browser config) and prints only the summary and failures. Use after changing apps/agent UI or route code to check just the affected tests, when `vp run -r test` is too broad or its filter does not reach apps/agent."
---

First argument: `unit` (default; app vite config, run inside apps/agent) or `browser` (apps/agent/vite.browser.config.ts, run from the repository root, for *.browser.tsx). Remaining arguments: test file paths relative to apps/agent, e.g. `browser app/entry/navigation/sidebar.browser.tsx`. Prints failing tests, assertion lines and the Test Files/Tests summary (or the output tail when none match); exits non-zero when a test fails.

Run with the `run_skill` tool (name `agent-test-files`). The script is `scripts/run.sh`; arguments arrive as `$1`, `$2`, ….
