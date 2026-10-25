#!/bin/sh
# git-show-file: print <path> as of <rev> (default HEAD).
set -u
if [ "$#" -lt 1 ]; then
  echo "usage: <path> [rev]" >&2
  exit 2
fi
rev="${2:-HEAD}"
git show "$rev:$1"
