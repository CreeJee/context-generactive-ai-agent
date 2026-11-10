---
name: native-read-bench
description: "Times the native memory seed read (candidate/vector/text stages, trigram vs short-term split, failure rate) on a read-only copy of a real agent.db, replaying recorded find_memory queries plus interpret- and recall-shaped queries, cold and warm. Prints only a markdown table of counts and p50/p95 times, never memory text. Use to measure search latency at real scale or to compare before/after a read_session.rs change."
---

Args: <db copy path> [index.tvim copy path] [--project <id>] [--rounds <n>] [--json <out file>] [--queries <jsonl>] [--lexical <dir|auto>] [--shared-session]. `--lexical` turns the text and morph stages on with that lexical index (`auto`: the copy's own under `<db dir>/lexical`, built by an app search run on the copy); without it both are off; `--shared-session` reads every query on one session, as the app's worker does. Rebuild the addon (turbovec-build) first after native changes.

Run with the `run_skill` tool (name `native-read-bench`). The script is `scripts/run.sh`; arguments arrive as `$1`, `$2`, ….
