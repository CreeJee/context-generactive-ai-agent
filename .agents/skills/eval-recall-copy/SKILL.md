---
name: eval-recall-copy
description: "Runs the synthetic recall evaluation (packages/memory-agent eval/recall.ts, same as `vp run eval:recall`) with the models from the git-ignored copy node_modules/.vp-tmp/cga-bench and a temp folder inside node_modules/.vp-tmp, since the sandbox cannot read ~/.context-generactive-agent/models. Prints the score lines (## ...) only, or misses too with --misses."
---

Args: [--misses] [configuration name, e.g. \"vector(quint8) + trigram + kiwi\"]. Exit status is the eval's.

Run with the `run_skill` tool (name `eval-recall-copy`). The script is `scripts/run.sh`; arguments arrive as `$1`, `$2`, ….
