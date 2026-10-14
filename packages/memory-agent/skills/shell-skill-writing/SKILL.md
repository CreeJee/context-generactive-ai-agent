---
name: "shell-skill-writing"
description: "How to write a good project shell skill. Read this before the first save_shell_skill call in a conversation, and whenever you are about to add a shell skill next to similar ones already listed."
---

# Writing shell skills

<!-- Adapted from Anthropic's skill-creator (https://github.com/anthropics/skills, skills/skill-creator),
licensed under the Apache License 2.0 (see LICENSE.txt). Changed: reduced to the principles that apply
to small, single-purpose shell skills saved with save_shell_skill; the interview, eval and packaging
workflow was removed. -->

A shell skill is a small, reusable command for one job in this project. Later runs (and other
agents) find it only through its name and description, and run it with `run_skill` without
another approval as long as the script is unchanged. Write it so that a future reader picks it
for the right task and gets just the output that task needs.

## Before saving

- Look at the listed skills first. If one already does the job, run it; if one nearly does,
  replace it under the same name rather than adding a near-duplicate.
- Save a skill for work you expect to repeat: building, testing, linting, git queries, package
  manager or project commands. A one-off check still goes through a skill, so keep it general
  enough to be worth keeping (take the changing part as an argument).
- Do not wrap what built-in tools already do: listing, reading, searching, writing or deleting
  files. Those tools are cheaper and need no approval.

## Name and description

- The name says the job in a few lowercase words: `test-failures`, `git-recent-changes`,
  `typecheck-package`.
- The description is what decides whether the skill is ever used. Say what it does and when to
  use it, including the situations where it should be picked even if the request does not name
  it. Models tend to under-use skills, so be concrete about the triggers rather than modest.
  For example, instead of "Runs tests", write "Runs the package's tests and prints only failing
  tests with their assertion output. Use after changing code in this package, before claiming a
  change works, or when the user asks whether tests pass."

## The script

- One job per script. Take what varies as arguments (`$1`, `$2`, …) and use safe defaults when
  they are missing.
- Print only what the task needs. Filter or cap noisy output inside the script (for example
  `2>&1 | tail -80`, or a reporter that shows failures only), so the result stays readable and
  cheap to send back. Keep the exit status meaningful: a failing check must exit non-zero.
- Arguments reach every later run without review, so do not pass them to `rm`, `eval`, `exec`,
  or a network upload. If a job truly needs that, say why in the reason so the user can judge.
- No surprises: the script should do exactly what its description says, nothing hidden.

## Usage text

- Say what each argument means and what the output shows, in the imperative and briefly. Explain
  why a step matters instead of writing rules in capitals; the next model reads it to decide how
  to call the skill.
