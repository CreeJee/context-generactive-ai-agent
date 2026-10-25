#!/bin/sh
# Usage: <message> <path> <content-file>
set -u
if [ "$#" -ne 3 ]; then
  echo "usage: <message> <path> <content-file>" >&2
  exit 2
fi
message="$1"; path="$2"; content="$3"
if [ -n "$(git diff --cached --name-only)" ]; then
  echo "index already has staged changes; commit or unstage them first" >&2
  exit 1
fi
mode="$(git ls-files -s -- "$path" | awk '{print $1}')"
[ -n "$mode" ] || mode=100644
blob="$(git hash-object -w -- "$content")" || exit 1
git update-index --cacheinfo "$mode,$blob,$path" || exit 1
git diff --cached --stat
git commit -m "$message" 2>&1 | tail -20
status=$?
git log --oneline -1
exit $status
