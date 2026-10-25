#!/bin/sh
# git-diff-paths: show unstaged and staged diffs of the given paths.
set -u
if [ "$#" -eq 0 ]; then
  echo "give at least one path" >&2
  exit 2
fi
echo "== unstaged =="
git diff --no-color -- "$@" | head -400
echo "== staged =="
git diff --cached --no-color -- "$@" | head -400
