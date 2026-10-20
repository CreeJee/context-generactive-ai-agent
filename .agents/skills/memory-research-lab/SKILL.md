---
name: memory-research-lab
description: "Isolates memory search failure types by timing each stage (fake embed, real model embed, FTS-only, morph-only, full native vector search) on the recall corpora inside this repo's runtime. Use when recall quality or search latency looks wrong and you need to know which pipeline stage causes it."
---

The optional argument selects one stage (`fake-embed`, `real-embed`, `fts-only`, `morph-only`, `full`); no argument runs every stage plus a verdict section naming which pipeline stage explains the numbers. Model stages need the local model files under the real storage root and are skipped with a reason where they are unreadable. Output is per-set top1/3/5, MRR, index/search/embed timings, degraded channels, misses, then the verdict lines.

Run with the `run_skill` tool (name `memory-research-lab`). The script is `scripts/run.sh`; arguments arrive as `$1`, `$2`, ….

Outside the sandbox the lab runs directly from the package: `cd packages/memory-agent && vp run eval:memory-lab` (optionally `-- <stage>`); the skill is the repo-root + sandbox fallback wrapper, not the only entry point. The lab registers the package directory itself (its cwd) as the project root, so memory it seeds lives under the temp storage root while project paths resolve to real directories.
