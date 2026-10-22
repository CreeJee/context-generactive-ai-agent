#!/bin/sh
# Records settled Tern findings from OUTSIDE the sandbox (tern writes its log to ~/.tern/agent/logs,
# which the sandbox denies). Args are finding ids; TERN_ARGS holds the resolve flags, e.g.
# '--disposition change --comment "..." --verbatim=false'. With no args prints the checks list.
T=/Users/creejee/.tern/bin/tern
[ -x "$T" ] || { echo "tern CLI not found at $T" >&2; exit 1; }
if [ $# -eq 0 ]; then
  exec "$T" checks list --repo "$(pwd)"
fi
for id in "$@"; do
  # shellcheck disable=SC2086
  "$T" checks resolve "$id" $TERN_ARGS --agent || exit 1
done
