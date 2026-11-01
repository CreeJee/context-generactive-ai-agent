cd packages/memory-agent || exit 2
root=$(cd ../.. && pwd)/node_modules/.vp-tmp
mkdir -p "$root/tmp"
show=scores
if [ "$1" = "--misses" ]; then show=all; shift; fi
out=$(TMPDIR="$root/tmp" node --no-warnings eval/recall.ts --models-root "$root/cga-bench" "$@" 2>&1)
code=$?
if [ $show = all ] || [ $code -ne 0 ]; then printf '%s\n' "$out" | tail -150; else printf '%s\n' "$out" | grep '^## '; fi
exit $code
