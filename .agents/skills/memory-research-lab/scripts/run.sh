# run_skill network: localhost
#!/bin/sh
# memory-research-lab: time isolated stages of memory search to find the failing one.
# Usage: memory-research-lab [stage]
# Stages: fake-embed | real-embed | fts-only | morph-only | full. No argument runs all of them.
# Runs the real lab script (packages/memory-agent/eval/memory-research-lab.ts), which mirrors
# eval/recall.ts's corpus, seeding and layer assembly, from packages/memory-agent.
# vp/node workers create IPC under TMPDIR/claude; the sandbox may deny the default TMPDIR,
# so TMPDIR is pointed into node_modules (gitignored) where writes are allowed.
set -u
VTMP="$PWD/node_modules/.vp-tmp"
mkdir -p "$VTMP"
TMPDIR="$VTMP"
export TMPDIR
cd packages/memory-agent
stage="${1:-}"
if [ -n "$stage" ]; then
  node --no-warnings eval/memory-research-lab.ts "$stage"
else
  node --no-warnings eval/memory-research-lab.ts
fi
