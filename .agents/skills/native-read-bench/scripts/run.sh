cd packages/memory-agent || exit 2
out=$(node --no-warnings eval/native-read-bench.ts "$@" 2>&1)
code=$?
printf '%s\n' "$out" | tail -60
exit $code
