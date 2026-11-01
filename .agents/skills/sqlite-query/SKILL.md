---
name: sqlite-query
description: "Runs one read-only SQL statement against a SQLite file (e.g. the measurement copy at node_modules/.vp-tmp/cga-bench/agent.db) and prints the rows as one JSON line. Use for quick schema/count probes over measurement copies; the app's own ~/.context-generactive-agent stays off limits."
---

Args: $1 = SQLite file path (project-relative), $2 = one SQL statement (SELECT/PRAGMA read). Prints rows as JSON, capped at 6000 chars. Exit non-zero on SQL or open errors.

Run with the `run_skill` tool (name `sqlite-query`). The script is `scripts/run.sh`; arguments arrive as `$1`, `$2`, ….
