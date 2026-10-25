# run_skill network: localhost
#!/bin/sh
# Usage: run.sh <unit|browser> <file relative to apps/agent>...
mode="${1:-unit}"
shift 2>/dev/null || true
if [ "$#" -eq 0 ]; then
  echo "give at least one test file relative to apps/agent" >&2
  exit 2
fi
if [ "$mode" = "browser" ]; then
  # The browser config's include paths are relative to the repository root.
  set -- $(for file in "$@"; do printf 'apps/agent/%s ' "$file"; done)
  out=$(vp test --config apps/agent/vite.browser.config.ts --run "$@" 2>&1)
else
  cd apps/agent || exit 2
  out=$(vp test run "$@" 2>&1)
fi
status=$?
filtered=$(printf '%s\n' "$out" | sed 's/\x1b\[[0-9;]*m//g' | grep -E '(FAIL|✗|×|AssertionError|Error:|expected|Expected|Received|Test Files|Tests |❯ .*\.test|❯ .*\.browser)' | head -120)
if [ -n "$filtered" ]; then
  printf '%s\n' "$filtered"
else
  # Nothing matched: show the tail so a setup failure is visible.
  printf '%s\n' "$out" | sed 's/\x1b\[[0-9;]*m//g' | tail -40
fi
exit $status
