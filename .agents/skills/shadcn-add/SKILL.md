---
name: shadcn-add
description: "Adds shadcn/ui components to apps/agent with the locally installed shadcn CLI (registry ui.shadcn.com), keeping existing component files (answers \"no\" to overwrite prompts) and printing only the CLI summary. Use whenever apps/agent UI needs a shadcn component it does not have yet (AGENTS.md requires shadcn components to be added through shadcn, not hand-written)."
---

Pass component names as arguments, e.g. `combobox`. Run from the project root. Prints the CLI output and the resulting ui folder listing.

Run with the `run_skill` tool (name `shadcn-add`). The script is `scripts/run.sh`; arguments arrive as `$1`, `$2`, ….
