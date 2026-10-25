# run_skill network: localhost
#!/bin/sh
# package-test-files: run the given vitest files/filters of the package in the working directory.
# Usage (workdir = package dir): package-test-files <file-or-filter> [more...]
set -u
if [ "$#" -eq 0 ]; then
  echo "give at least one test file or filter" >&2
  exit 2
fi
# vp keeps its IPC socket under TMPDIR; point it at a writable, gitignored place.
VTMP="$PWD/node_modules/.vp-tmp"
mkdir -p "$VTMP"
TMPDIR="$VTMP"
export TMPDIR
out="$(vp test run "$@" 2>&1)"
status=$?
if [ "$status" -eq 0 ]; then
  echo "tests passed"
  printf '%s\n' "$out" | grep -E "Test Files|Tests |Duration" | tail -4
  exit 0
fi
echo "== failing tests =="
printf '%s\n' "$out" | grep -E "FAIL|✗|×" | head -60
echo "== tail of test output =="
printf '%s\n' "$out" | tail -80
exit "$status"
