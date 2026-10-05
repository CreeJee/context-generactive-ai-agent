# RRSI local experiments (2026-10-05)

This is a review preview of [RRSI](https://arxiv.org/abs/2609.24972), adapted to
Context Agent. All registered providers (OpenAI, Anthropic and OpenAI-compatible)
are eligible; the experiment pins the selected model/account and does not fall back
to another provider. The [reference implementation](https://github.com/google-research/rrsi)
uses different domains and models; its reported benchmark gains do not describe this app.

## Delivered behavior

- Independent clone and `feat/rrsi-local`; original checkout/HMR unchanged.
- `vp run dev:rrsi` uses `.rrsi-local/runtime`, web 5174 and backend 5181.
  The authorized local connection config and endpoint-bound keyring are reused;
  conversation DBs and OAuth accounts are separate. Local files are ignored by Git.
- Settings → 하네스 개선 exposes idle scheduling, start/stop, history, candidate
  diffs/commits/artifact IDs and profile rollback.
- Immutable profile versions are pinned to Goals. Adoption affects new Goals;
  restoring the current profile does not rewrite existing Goal pins.
- Three baseline repeats calibrate a score range. Two rounds with two proposals
  use an edit budget of 3 then 1, history/exploration, a leakage critic,
  domain regression guards and token-aware selection. Defaults are 10 minutes
  idle, once/day and 30 minutes, with no total token cap. Work in either app cancels
  evaluation; app restart marks unfinished experiments cancelled.
- Profile adoption requires separate validation and a sealed suite. The sealed
  corpus version can be consumed only once: subsequent experiments require a
  new corpus version rather than repeated tuning on held-out answers.
- Code exploration follows an adopted profile when execution time remains. Only five
  harness source paths can change. Exact replacement anchors are applied to a
  separate candidate worktree; formatting/type checks and focused regression
  tests precede isolated validation. Passing candidates remain review pending.

## Evaluation and review

Build the evaluator before starting an experiment:

```sh
docker build -f tools/rrsi/Dockerfile -t context-agent-rrsi:local .
vp run dev:rrsi
```

The host pins the Docker image ID, selected provider/model and connection/account for the run.
OpenAI-compatible requests use the configured endpoint; subscription requests reuse
the native adapter and preserve tool calls, reasoning/signatures and usage.
Credentials stay in the host, and pinned subscription accounts are released when
the experiment completes, fails or is cancelled. The separate app uses its own
subscription login; this change does not copy OAuth accounts from the original app.
The worker runs actual chat/memory logic with deterministic embedding/morph fixtures.
It has a temporary task workspace, no network, no credentials or host mounts,
read-only root filesystem and resource limits. Model requests pass through the
host gateway. Missing usage, no model calls, cancellation or incomplete trials
prevent adoption. The synthetic corpus is small; it is not an external benchmark
or evidence of production memory/retrieval quality.

For a code candidate, inspect the recorded branch, commit, image hash, diff and
measurements. Review and merge/cherry-pick that commit using the normal Git/PR
workflow, then restart the separate app. Code is never hot-swapped automatically.
Git revert rolls back code; the settings button rolls back profile configuration.
Goal pins cover profiles, not separate executable versions of previously merged code.

## Verification and current limits

Provider expansion checks passed: `vp check`, app/package type checks, application
bundle and Docker build. The full suite ran 175 files: 171 passed, with nine
failures and three asynchronous errors in four worker-heavy files. Follow-up
serial/isolated runs of the worker files passed (five files, 33 tests, including
an additional admission regression). The complete parallel run did not pass.

Provider expansion was verified with scripted replies through the real Docker
chat worker for OpenAI-compatible, OpenAI and Anthropic: each completed the smoke
suite with seven requests and usage accounting. This is protocol verification,
not an authenticated paid-provider run or measured quality improvement.

- Worker request waits now use Deferred and a scoped, interruptible input reader.
  Parallel requests are correlated by ID; interruption removes pending registration
  and input shutdown fails all remaining waiters.
- Static checks, app/package type checks, application bundle, Docker evaluator
  build, migration/Goal-pin/selection tests and the settings page have been exercised.
- The first full suite passed 174 files / 1069 tests with 2 skipped. A later run
  found a macOS temporary-directory canonicalization bug in the new code guard,
  which was fixed, plus a worker-heavy admission-test timeout; targeted serial
  reruns are recorded in the PR.
- A live smoke evaluation reached the configured local model through the isolated
  chat worker: 8 completion calls and 57,503 reported tokens. It exceeded the
  240-second smoke deadline before returning both trial results. No profile or
  code candidate was adopted. Full evolution/adoption and code-candidate build /
  validation have not been proven against this model.
- The total token cap was removed by user decision. The 30-minute deadline may
  still be insufficient for the current corpus and model. The experiment stops rather than treating partial measurements as
  successful evaluation. Token usage is still recorded for candidate selection; a configured provider may
  impose its own quotas and charges.
- Cost coefficients (`beta0=0.1`, `beta1=2`) are project defaults, not the paper's
  fitted parameters. Noise uses a repeated-score range, not a confidence interval.
  History asks for removal of unhelpful edits; there is no separate ablation pass,
  structural novelty bonus or enforced exploration-slot reservation yet.
- Code candidates remain quarantined review artifacts. Reusable corpus renewal,
  production embedding evaluation and an end-to-end measured improvement are
  required before treating this as a validated automatic-improvement system.
