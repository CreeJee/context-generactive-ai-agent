# run_skill network: ui.shadcn.com
set -e
cd apps/agent
if [ "$#" -eq 0 ]; then echo "usage: shadcn-add <component>..." >&2; exit 2; fi
# Existing components carry local edits: decline every overwrite prompt.
yes n 2>/dev/null | ./node_modules/.bin/shadcn add "$@" 2>&1 | tail -40
ls app/components/ui
