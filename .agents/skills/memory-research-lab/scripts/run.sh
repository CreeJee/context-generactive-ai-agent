#!/bin/sh
# memory-research-lab: time isolated stages of memory search to find the failing one.
# Usage: memory-research-lab [stage]
# Stages: fake-embed | real-embed | fts-only | morph-only | full. No argument runs all of them.
# The lab itself lives in packages/memory-agent/eval and is also runnable directly with
# `vp run eval:memory-lab` from that package. This skill only adds: running it from the repo
# root and, when the default temp dir is not writable (Orca sandbox), a TMPDIR fallback
# under node_modules (gitignored) where vp/node workers create their IPC sockets.
set -u
VTMP="$PWD/node_modules/.vp-tmp"
if [ ! -w "${TMPDIR:-/tmp}" ]; then
  mkdir -p "$VTMP"
  TMPDIR="$VTMP"
  export TMPDIR
fi
cd packages/memory-agent
if [ -n "${1:-}" ]; then
  exec vp run eval:memory-lab -- "$1"
else
  exec vp run eval:memory-lab
fi
