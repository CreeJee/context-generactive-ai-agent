---
name: "code-skill-writing"
description: "How to write a good project code skill, ts or sh. Read this before the first save_code_skill call in a conversation, and whenever you are about to add a code skill next to similar ones already listed."
---

# Writing code skills

<!-- Adapted from Anthropic's skill-creator (https://github.com/anthropics/skills, skills/skill-creator),
licensed under the Apache License 2.0 (see LICENSE.txt). Changed: reduced to the principles that apply
to small, single-purpose code skills saved with save_code_skill; the interview, eval and packaging
workflow was removed. -->

A code skill is a small, reusable program for one job in this project. Later runs (and other
agents) find it only through its name and description, and run it with `run_skill` without
another approval as long as the program is unchanged. Write it so that a future reader picks it
for the right task and gets just the result that task needs.

A skill is one of two kinds:

- **ts**: TypeScript that calls this app's tools as functions, such as
  `await external_read_file({ path })`. Use it for work that would otherwise take many tool calls:
  checking a set of files, changing several files the same way, combining sh skills and searches.
  It runs in a code sandbox that reaches nothing but those tools.
- **sh**: a `/bin/sh` script, the only way to run a host command: builds, tests, linters, git,
  package managers and project commands.

## Before saving

- Look at the listed skills first. If one already does the job, run it; if one nearly does,
  replace it under the same name rather than adding a near-duplicate.
- Save a skill for work you expect to repeat. Work of many calls that you do once goes in
  `run_code` instead.
- Try a ts program with `run_code` before saving it. Put a `const input = { … };` line on top to
  stand in for run_skill's input, and drop that line when you save the program.
- Do not save a sh script that only wraps what built-in tools already do: listing, reading,
  searching, writing or deleting files. Those tools are cheaper and need no approval. To combine
  them, write a ts skill.

## Name and description

- The name says the job in a few lowercase words: `test-failures`, `git-recent-changes`,
  `rename-export`.
- The description is what decides whether the skill is ever used. Say what it does and when to
  use it, including the situations where it should be picked even if the request does not name
  it. Models tend to under-use skills, so be concrete about the triggers rather than modest.
  For example, instead of "Runs tests", write "Runs the package's tests and prints only failing
  tests with their assertion output. Use after changing code in this package, before claiming a
  change works, or when the user asks whether tests pass."
- The skill list ends a ts skill's description with its input. Do not write that part yourself.

## A ts program

- The code is the body of an async function. `input` holds what run_skill was given, already
  checked against the schema. `return` a JSON value; run_skill gives it back.
- Declare the input as a JSON Schema of type `object` with the fields that vary, and list the
  ones that must be given in `required`. Without a schema, the skill takes no input.
- Call a tool as `await external_<tool name>(input)`. A failed call throws an Error with the
  tool's message: catch it where the program can carry on, and let it end the run where it cannot.
- Run independent calls at once with `Promise.all`. Return only what the task needs, not every
  tool result.
- The program reaches nothing but the tools: no files, network, processes, imports or timers.
  Tools that ask before each call are not available, and from a program run_skill runs only sh
  skills.
- `console.log` lines come back with the result. Use them for progress, not for the answer.

## A sh script

- One job per script. Take what varies as arguments (`$1`, `$2`, …) and use safe defaults when
  they are missing.
- Print only what the task needs. Filter or cap noisy output inside the script (for example
  `2>&1 | tail -80`, or a reporter that shows failures only), so the result stays readable and
  cheap to send back. Keep the exit status meaningful: a failing check must exit non-zero.

## What later runs may do

- Input and arguments reach every later run without review. Do not pass a sh argument to `rm`,
  `eval`, `exec` or a network upload, and do not let a ts input choose files to delete or
  overwrite beyond the skill's job. If a job truly needs that, say why in the reason so the user
  can judge.
- No surprises: the program should do exactly what its description says, nothing hidden.

## Network and sandbox for sh scripts

- Scripts run in a sandbox: they can write only inside the project, temp folders and package
  caches, and cannot read credential folders. Do not try to work around it; a job that needs more
  is one to hand back to the user.
- List in `network` exactly the hosts the job needs (`registry.npmjs.org` for an npm install,
  `github.com` for a git fetch over https), and nothing for a script that works offline. The
  user approves this list with the script, so a narrow list is easier to trust than a wildcard.
- `localhost` lets the script use loopback ports (local test or dev servers), and with them every
  local service. List it only when the job runs or talks to a local server.
- A blocked host shows in stderr under `<sandbox_violations>`. Add it only if the job truly needs
  it, and say why in the reason. Git over ssh cannot pass the sandbox; use https remotes.

## Usage text

- Say what each input field or argument means and what the result shows, in the imperative and
  briefly. Explain why a step matters instead of writing rules in capitals; the next model reads
  it to decide how to call the skill.
