#!/bin/sh
# Resolve a tern check finding: tern checks resolve <id> [flags...]
# $1 = finding id (e.g. oNydTZue2DAI); remaining args are passed to tern as-is
# (use pairs like: --disposition change --recommended change --comment "..." --verbatim=false --agent)
# Output: tern's stdout only; exits non-zero if tern fails.
if [ -z "$1" ]; then
  echo "usage: tern-checks-resolve <id> [--disposition ... --recommended ... --comment ...]" >&2
  exit 2
fi
id=$1
shift
exec /Users/creejee/.tern/bin/tern checks resolve "$id" "$@"
