#!/bin/sh
# Usage: run.sh <message> <path>...
message="$1"
shift 2>/dev/null || true
if [ -z "$message" ] || [ "$#" -eq 0 ]; then
  echo "usage: <message> <path>..." >&2
  exit 2
fi
git add -- "$@" || exit 1
git commit -m "$message" -- "$@" 2>&1 | tail -20
status=$?
git log --oneline -1
exit $status
