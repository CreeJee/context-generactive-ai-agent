---
name: tern-checks-resolve
description: "Resolves one tern check finding by id with a disposition/recommended/comment, printing tern's stdout. Use whenever a tern review hook leaves findings that the developer settled and the session needs to record the decision (tern checks resolve <id>)."
---

Run as: tern-checks-resolve <finding-id> followed by the tern flags verbatim, e.g. `--disposition change --recommended change --comment "text" --verbatim=false --agent`. $1 is the finding id; all remaining arguments are forwarded to `tern checks resolve` unchanged. Prints tern's exact stdout and exits with tern's exit status.

Run with the `run_skill` tool (name `tern-checks-resolve`). The script is `scripts/run.sh`; arguments arrive as `$1`, `$2`, ….
