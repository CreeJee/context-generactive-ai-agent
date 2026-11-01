---
name: turbovec-build
description: "Rebuilds the turbovec N-API addon (packages/turbovec, `vp run build`, cached by crate inputs) and prints the last lines of the build output. Use after changing packages/turbovec Rust code or its NativeReadOutput/Input shape, before running memory-agent tests or evals that load the native addon."
---

No arguments. Exit status is the build's.

Run with the `run_skill` tool (name `turbovec-build`). The script is `scripts/run.sh`; arguments arrive as `$1`, `$2`, ….
