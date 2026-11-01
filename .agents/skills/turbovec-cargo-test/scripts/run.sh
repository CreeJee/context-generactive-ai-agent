cd packages/turbovec || exit 2
export CARGO_TERM_COLOR=never
# read_session tests open SQLite files under std::env::temp_dir(). The sandbox TMPDIR
# may be missing or unwritable, which fails them with CannotOpen before any assertion;
# point TMPDIR at a fresh writable directory inside the gitignored target/.
tmpdir="$(mktemp -d "$PWD/target/test-tmp.XXXXXX" 2>/dev/null)" || tmpdir=""
[ -n "$tmpdir" ] && export TMPDIR="$tmpdir"
out=$(cargo test --release --locked --no-default-features --features test-sqlite "$@" 2>&1)
code=$?
[ -n "$tmpdir" ] && rm -rf "$tmpdir"
printf '%s\n' "$out" | grep -E '^(error|warning: unused|test result|failures:|---- |thread .* panicked|  left|  right|test .* FAILED)|^\s+--> ' | head -120
if [ $code -ne 0 ]; then printf '%s\n' "$out" | tail -40; fi
exit $code
