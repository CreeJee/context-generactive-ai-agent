# run_skill network: localhost
#!/bin/sh
# test-failures: run the monorepo test suite and print only failing tests with their assertion output.
# Usage: test-failures [extra vp run args...]
# Extra arguments are forwarded to `vp run -r test`, e.g. `agent#test` or `memory-agent#test`.
# Runs in the project root (run_skill's working directory).
# vp creates its task IPC socket under TMPDIR/claude. The sandbox may deny writes
# to /tmp and the Darwin default TMPDIR, so TMPDIR is pointed into node_modules
# (gitignored) where writes are allowed.
set -u
VTMP="$PWD/node_modules/.vp-tmp"
mkdir -p "$VTMP"
TMPDIR="$VTMP"
export TMPDIR
out="$(vp run -r test "$@" 2>&1)"
status=$?
if [ "$status" -eq 0 ]; then
  echo "all tests passed"
  printf '%s\n' "$out" | grep -E "Test Files|Tests |Duration" | tail -4
  exit 0
fi
echo "== failing tests =="
printf '%s\n' "$out" | grep -E "FAIL|✗|×" | head -60
echo "== tail of test output =="
printf '%s\n' "$out" | tail -60
exit "$status"
