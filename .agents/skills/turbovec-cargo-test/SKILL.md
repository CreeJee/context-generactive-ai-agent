---
name: turbovec-cargo-test
description: "Runs the Rust unit tests of packages/turbovec (cargo test --release --locked --no-default-features --features test-sqlite) and prints compile errors, failing tests and the result summary only. Use after changing any packages/turbovec/src/*.rs file, before rebuilding the addon or claiming the native change works."
---

No arguments run the whole suite. Extra args are passed to cargo test (e.g. a test name filter). Exit status is cargo's. A clean run prints the `test result:` line only.

Run with the `run_skill` tool (name `turbovec-cargo-test`). The script is `scripts/run.sh`; arguments arrive as `$1`, `$2`, ….
