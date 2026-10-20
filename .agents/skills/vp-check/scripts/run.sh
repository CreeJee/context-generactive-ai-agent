#!/bin/sh
# vp-check: run `vp check` (format, lint, type check) and print only errors.
# Usage: vp-check [extra vp check args...]
# Runs in the project root (run_skill's working directory).
# Output is kept in a shell variable: the sandbox may reject temp files outside the project.
set -u
out="$(vp check "$@" 2>&1)"
status=$?
if [ "$status" -eq 0 ]; then
  echo "vp check: clean"
  exit 0
fi
echo "== problems =="
printf '%s\n' "$out" | grep -inE "error|✗|failed" | head -60
echo "== tail of check output =="
printf '%s\n' "$out" | tail -40
exit "$status"
