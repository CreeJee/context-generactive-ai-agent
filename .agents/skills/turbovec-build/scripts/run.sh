# run_skill network: github.com index.crates.io static.crates.io
cd packages/turbovec || exit 2
out=$(vp run build 2>&1)
code=$?
printf '%s\n' "$out" | grep -vE '^\s+(Compiling|Downloaded|Downloading)' | tail -40
exit $code
