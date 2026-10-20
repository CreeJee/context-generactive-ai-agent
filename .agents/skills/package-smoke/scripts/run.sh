# run_skill network: localhost
#!/bin/sh
# package-smoke: build the current-device executable and run its smoke check.
# Usage: package-smoke
# Runs `vp run package` then `vp run smoke-package` in apps/agent (README's packaging check).
# The project root is run_skill's working directory; apps/agent sits below it.
# vp creates its task IPC socket under TMPDIR/claude. The sandbox may deny writes
# to /tmp and the Darwin default TMPDIR, so TMPDIR is pointed into node_modules
# (gitignored) where writes are allowed.
set -u
VTMP="$PWD/node_modules/.vp-tmp"
mkdir -p "$VTMP"
TMPDIR="$VTMP"
export TMPDIR
cd apps/agent
vp run package || exit $?
vp run smoke-package
