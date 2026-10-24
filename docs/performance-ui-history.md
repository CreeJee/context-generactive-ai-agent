# Independent history UI processing (2026-10-07)

Status: implementation and fixed-data browser measurements; do not count history response-size reduction as UI optimization. Full stage completion is tracked in the Plan, not inferred from this document.

## Change and preserved data

`ToolCallCard` has controlled open state and creates its detail subtree only when open. Previously, closed cards still evaluated inline `pretty(call.arguments)` and `pretty(resultText(result))` before the Base UI panel could decide not to mount its DOM. Arguments/results, page size, DB, API payload and model context are unchanged. Status/approval badges and drawing previews stay outside the gated details.

## Repeatable browser comparison

`UI_HISTORY_MODE=before|after node tools/suspense-verification.ts` uses the actual app and actual React renderer, 20 tools with argument JSON 131,111 bytes and result JSON 131,113 bytes each. Identical browser fixtures and delayed history/catalog conditions apply to both modes. Before mode locally replays historical eager evaluation by changing exactly one `open &&` in the browser-delivered dev module; it does not revert the working source or DB. Both modes use the same browser-only React Profiler wrapper. This is a development/fixture comparison, not a production build benchmark.

Three alternating fresh-browser pairs (task `a6d54712-d693-4607-ae27-8eb967666a81`, complete result read):

| Measurement                         | Historical eager | Lazy closed details |
| ----------------------------------- | ---------------- | ------------------- |
| Initial subtree mount/render median | 38.9 ms          | 31.3 ms             |
| Initial subtree mount/render range  | 38.4–40.5 ms     | 29.1–32.3 ms        |
| Target argument JSON parses         | 40 / 40 / 40     | 0 / 0 / 0           |
| Target result JSON parses           | 160 / 160 / 160  | 120 / 120 / 120     |
| Target JSON parse time median       | 6.7 ms           | 6.1 ms              |

Counts include dev rendering and the preserved refusal/drawing decoders; they are not claimed as one parse per visible tool. Three pairs do not establish a p95. JSON timers are quantized/noisy; one earlier pair was 4.7→4.8 ms and is not a parse-time improvement. Actual React `actualDuration` is render work; `commitTime` is a timestamp, not a DOM commit-duration measurement.

All six runs also asserted: actual 20 tool cards present; opening restores the original details; closing removes detail DOM; scrolling remains possible; delayed catalog/history overlap; ready shell/history before catalog completion; catalog 503; A→B→A and late B response isolation; actual server mutation count 0; page errors 0.

## Phase separation and limitations

Root and index route contain no history loader/prefetch/dehydrated QueryClient cache. `ChatPanel` uses client `useChat` hydration. The measured message subtree mounts after API delivery, rather than being the initial SSR history subtree. Initial shell boot/bundle/SSR hydration remains a separate window: CDP metrics sampled just before the delayed history response are not mislabeled as pure SSR hydration duration.

In one CDP pair (task `0e80c61f-af90-4ee7-bf80-d74939d0ec93`, all three result pages read), delivery→first-observed-ready-record CPU counters changed: ScriptDuration 73.509→57.056 ms, TaskDuration 113.626→86.301 ms, LayoutDuration 9.726→5.192 ms, RecalcStyleDuration 1.759→1.650 ms, layout count 4→3. These are cumulative renderer work including SDK/client processing and DOM/layout, not a longest blocking task or pure React/JSON normalization duration. Bootstrap counters were retained separately, and elapsed navigation/network/bundle time was not substituted for UI work.

Long-task observer verification (task `013c5522-4c65-4cf7-b1bc-bec618d37ce9`): in one fixed-data pair, the historical delivery→display window had a 61 ms long task and the lazy window had no task reported above the observer's 50 ms threshold. This does not imply zero blocking. CDP task CPU was 109.416→97.313 ms and layout CPU 10.252→7.333 ms; another parse-time pair was 6.0→6.2 ms, so counting fewer parses is more reliable than treating every timing sample as an improvement.

Latest run/approval browser regression reused the existing actual-SDK fixture in both ordinary and approval modes (task `2c1290f8-5367-44ce-a341-acaa963ccc2e`): both passed, preserving navigation/draft/lease/run/approval isolation with no real server mutations. Each fixed-data measurement also repeated the tool detail/open-close and late-response assertions.

## Actual SDK / hydration / DOM boundaries

The remaining boundary check now passes (task `096a2d7b-3eeb-4694-953f-18297086c4fb`, both result pages read). Browser-only wrappers instrument the actual installed dev SDK `normalizeMessagesDates` and `processor.setMessages`, and React `performWorkOnRoot`, `commitRoot`, `commitMutationEffectsOnFiber`, `commitLayoutEffectOnFiber`. Every wrapper preserves original arguments, receiver and return/throw behavior; recursive phases report only their outer call. Assertions require normalization, processor application, DOM mutations and an initially dehydrated SSR root to actually be observed. No dependency files or app source are changed by the measurement.

| Boundary, one fixed-data pair                               | Before           | After                          |
| ----------------------------------------------------------- | ---------------- | ------------------------------ |
| History date normalization                                  | 4 calls / 0.1 ms | 4 calls / timer-rounded 0.0 ms |
| Processor message application (including callback emission) | 2 / 0.1 ms       | 2 / 0.2 ms                     |
| History commitRoot                                          | 13 / 27.3 ms     | 4 / 11.3 ms                    |
| History DOM mutation outer traversal                        | 11 / 3.8 ms      | 5 / 1.2 ms                     |
| History layout-effect outer traversal                       | 11 / 13.7 ms     | 5 / 6.9 ms                     |
| Target React message subtree mount                          | 39.2 ms          | 28.1 ms                        |

Date normalization and processor application are separate from React render and DOM traversal and are not the expensive work targeted by this change. `processor.setMessages` includes synchronous callback emission, not only a copy. CommitRoot includes other phases; traversal timings include their nested calls/effects. These timings overlap and **must not be added**. Root commit counts differ because the window includes auxiliary state updates; aggregate deltas are not all causally assigned to this tool change. Zero rounded timer samples mean below resolution, not zero cost.

Initial SSR hydration was positively identified from the root's `isDehydrated` state: before 11 `performWorkOnRoot` calls / 90.7 ms and one commit / 36.6 ms, after 9 / 74.8 ms and one commit / 28.9 ms. Work includes commit; this is hydration-associated synchronous CPU across concurrent passes, not continuous navigation-to-hydration wall time or shell-only exclusive CPU. SSR history data remains empty: the expensive record subtree is CSR-mounted after history GET. There is **no claim of SSR hydration optimization** from changing a CSR tool detail guard.

Both modes also passed the same fixed-body tool open/close/scroll, delayed catalog, error, fast-switch and no-mutation assertions. Static format/lint/type check passed. This closes the remaining phase-distinction check without relabeling Profiler commit timestamps as durations. No claim is made that the earlier 10-second symptoms are fully resolved by this optimization.

## Verification repairs

The first instrumented run lacked DOM types for browser callbacks; the harness now explicitly references the DOM lib without changing repository compiler settings. The first Profiler wrapper lost the named `MessageView` export, causing a fixture locator timeout; inspecting the actual dev module and preserving its export fixed the harness. Both were verification setup failures, not proof of product latency regressions. Targeted format/lint/type checks and subsequent real-browser comparisons passed.

## Streaming tick / scroll / prepend cost attribution (2026-10-21)

A fixed-data fixture measures what one streaming tick, one upward scroll, and one older-page
prepend each cost on a 400-message history, separating React render/commit from CDP layout/style
work and long tasks. The table below holds the raw numbers. The harness was a one-off Playwright
script against the dev server `5173` (chromium `--single-process`); it and its per-run JSON are
not kept in the repository.

- Fixture: route-fulfilled `/api/*` — 400 alternating user/assistant text messages served
  through the real `/api/chat` GET paging shape (20 newest + `page: {truncated, cursor}`), lease
  `mine`, run-state idle, a one-frame SSE tick after 1.2 s. No app source, dependency file, DB,
  or real server run changes.
- Instrumentation: a dev-module wrapper counts every `MessageView` render per message id;
  a second counter sits at the `ChatHistory` `messages.map` call site (`HistoryRow`), separating
  the map callback from the `MessageView` body itself; a dev-module wrapper on the react-dom
  prebundle renames `commitRoot` → `commitRootImpl` and times every commit through a
  same-signature wrapper (`__uiProbeCommit`); CDP `Performance.getMetrics` deltas cover
  TaskDuration, ScriptDuration, LayoutDuration, RecalcStyleDuration, Layout/RecalcStyle counts
  and Nodes; a `longtask` PerformanceObserver covers 50 ms+ tasks. Ticks and scroll windows are
  measured inside fresh pages, each with an 800 ms settle before the window and a no-content
  baseline run of the same send path.

Raw numbers (both runs, CDP deltas; render totals are per-message counts summed):

| Window                          | Run | TaskDuration Δ | Layout Δ | RecalcStyle Δ | Layout/style count |    MessageView renders (total) | commits (count / total ms / max) | long tasks         |
| ------------------------------- | --- | -------------: | -------: | ------------: | ------------------ | -----------------------------: | -------------------------------- | ------------------ |
| hydration                       | 1   |          0.798 |    0.019 |         0.031 | 10 / 22            |                            440 | 20 / 130.2 / 52.7                | 139, 59, 63, 68 ms |
| hydration                       | 2   |          0.836 |    0.039 |         0.065 | 11 / 22            |                            360 | 21 / 110.5 / 62                  | 131, 68, 64 ms     |
| tick − baseline                 | 1   |          0.038 |    0.018 |        0.0001 | 1 / −8             |                            204 | 3 / 2.9 / 0.5                    | one 60 ms          |
| tick − baseline                 | 2   |          0.103 |    0.058 |         0.002 | 1 / −4             |                              4 | 0 / 75.4 / 26.5                  | one 111 ms         |
| small scroll (crossed sentinel) | 1   |          0.051 |   0.0004 |         0.001 | 2 / 4              |                            480 | 25 / 88.3 / 37                   | none               |
| prepend                         | 1   |          0.108 |   0.0004 |         0.001 | 2 / 4              |                            720 | 31 / 91.7 / 37                   | none               |
| small scroll (crossed sentinel) | 2   |          0.046 |   0.0006 |         0.001 | 2 / 4              |                            440 | 28 / 110.2 / 47.2                | none               |
| prepend                         | 2   |          0.078 |   0.0005 |         0.001 | 2 / 4              |                            680 | 34 / 113.5 / 47.2                | none               |
| site-split: tick window         | 3   |          0.165 |    0.073 |         0.007 | 5 / 30             | 1128 (28/message × 2 counters) | 23 / 192.6 / 77.5                | one 118 ms         |
| site-split: prepend             | 3   |          0.099 |   0.0004 |         0.001 | 2 / 4              |                           1360 | 36 / 124.4 / 62                  | none               |

Findings:

- **The last message is not the only renderer.** On every send every mounted `MessageView`
  re-renders the same number of times (run 1: 46 each; run 2: 40 each), because `MessageView`
  is not memoized and its props (tasks, approvals, trace connection) are recreated by
  `ChatPanel` on each SDK state change. The streaming tick confirms this: existing messages'
  render counts rise by the same +10 (run 1 tick − baseline) as the last message's own
  renders rise (18 vs 16, 14 vs 12). The site-split runs show identical counts at the
  `HistoryRow` map call site and inside the `MessageView` body (tick window: 26/26 then 28/28
  per message on both sides, 4/4 for the new turn), so the counts are genuine `MessageView`
  body re-renders, not the parent re-invoking its render callback. The hypothesis "only the
  last message renders during streaming" is excluded.
- **Re-render churn, not offscreen layout/paint, dominates; the tick adds one extra layout
  pass.** The tick-minus-baseline render delta is small (204 / 4 additional component renders
  across 2.8 s; per existing message only +10/+0), while its CDP delta is LayoutDuration
  0.018/0.058 ms with exactly one extra layout pass and an unchanged layout/style count
  (−8/−4, within counter noise) — plus a single 60/111 ms long task that only the tick case
  produces. The commit distribution inside the tick window is top-heavy across three samples:
  23–24 commits totaling ~120–193 ms with a 54–78 ms maximum and a ~16–58 ms second tier, so a
  few commits carry the cost instead of the render fan-out. Scroll and prepend stay
  layout-cheap (LayoutDuration ≤ 0.001 ms, 2/4 layout/style counts) while their ScriptDuration
  is the largest single component (0.04–0.095 ms deltas). Neither case shows paint-scale
  layout cost: the dominant cause is re-render churn (every message, every state change), and
  the streaming tick additionally pays one offscreen-marked layout pass inside a long task —
  both, with re-render as the ruling share.
- **Limits.** Dev build, dev-server prebundles, single-process headless chromium, route-fulfilled
  fixtures (no real model, no DB); the SSE tick arrives as one body after 1.2 s rather than
  incremental chunks; commit timings include all commits in the window (SDK/lease/queue state
  updates included), not only the history subtree; the "small scroll" window crossed the top
  sentinel in every run (count 20→40), so its numbers are prepend-adjacent and the prepend row
  is the cleaner (c) measurement; RecalcStyleCount can go negative across a window because CDP
  counters are process-wide and other tasks (lease renewals, SSE) run between snapshots; an
  earlier sample shared one stray 125.9 ms commit between its scroll and prepend
  windows (counter not reset between them) and was rerun with the reset in place;
  the runs of one day are reported raw without aggregation.

## Message memo, a content-visibility trial and virtualization (2026-10-24)

The same fixture shape as the 2026-10-21 run: 400 alternating text messages behind the real
`/api/chat` paging shape, every `/api` request answered by Playwright, so no backend or DB is
reached. A "rich" variant gives each assistant message a heading, two paragraphs, a list and a
code block (about 480 px each). Development build on the dev server `5173`, headless chromium
`--single-process`, 1280×800, two runs per row. Each window opens a fresh page and settles for
1.2 s first.

- Counters: the browser-delivered `message.tsx` and `chat-history.tsx` modules get the same two
  render counters as on 10-21 (the `MessageView` body, the `messages.map` call site).
- React work: a DevTools-hook stub sums each commit's root `actualDuration`. This is render work;
  it is not commit-phase time and is not comparable with the 10-21 commit timer.
- CDP `Performance.getMetrics` deltas and a `longtask` observer, as on 10-21.
- The tick window is one send plus one SSE body with start, four content deltas and finish,
  read 2.2 s later. The harness was a one-off and is not kept in the repository.

`MessageView`, `ToolCallCard` and `TaskSummaryCard` are now memoized. `MessageView` compares the
message by reference and, from the session-wide approval and task lists, only what its own tool
calls read. The three task actions keep their identity through `useCallback` over `mutateAsync`.

| Plain fixture                                           |  Before (2602d49a) |    Memo (9336e6bc) |
| ------------------------------------------------------- | -----------------: | -----------------: |
| Tick: existing messages' `MessageView` renders, 20 rows |      520 (26 each) |                  0 |
| Tick: new user / assistant message renders              |            24 / 20 |             4 / 12 |
| Tick: React render in the window (commits)              | 155–165 ms (15–16) | 109–115 ms (15–16) |
| Tick: largest commit                                    |           19–24 ms |           12–16 ms |
| Small scroll (20 → 40 rows): `MessageView` renders      |                 80 |                 40 |
| Prepend (40 → 60 rows): `MessageView` renders           |                240 |                 40 |
| Prepend: React render                                   |           62–76 ms |           49–51 ms |
| Tick with 202 rows mounted: React render                |                  – |         148–156 ms |

- The `messages.map` callback still runs for every row on every commit (26 times per row in the
  tick window). `ChatHistory` renders with `ChatPanel` and hands each row a new element; the memo
  compare then skips the body. With 202 rows mounted this adds about 3 ms per commit (about
  0.017 ms per row).
- Unchanged in both runs: the view stays at the bottom after the tick (0 px from the bottom); the
  reading row stays at 24 px across a prepend; each 150 px upward step moves the reading row by
  exactly 150 px.

`content-visibility: auto` was tried on each row, with `contain-intrinsic-size: auto 2.5rem`. The
estimate comes from the stored history: of 37,716 rows, 89% are assistant steps with a median of
one tool call and no text (a collapsed tool card, about 30 px); user rows have a median of
45 characters (one line, about 40 px).

| Window                                                                | Memo only                | Memo + content-visibility |
| --------------------------------------------------------------------- | ------------------------ | ------------------------- |
| Small scroll, plain: Layout / layouts / style recalcs                 | 0.4 ms / 2 / 4           | 0.6 ms / 5–6 / 9–10       |
| Prepend, plain                                                        | 0.4–0.5 ms / 2 / 4       | 0.5–0.6 ms / 4 / 7        |
| Prepend, rich                                                         | 2.0–2.1 ms / 6 / 9       | 1.5–1.7 ms / 6–7 / 9–10   |
| Width change, 200 rich rows mounted: Layout / RecalcStyle             | 16–23 ms / 14–25 ms      | 4.5–9 ms / 6–14 ms        |
| 4,000 px upward scroll, 200 rich rows: Layout / RecalcStyle / layouts | 5.5–6.3 ms / 8–11 ms / 9 | 8.7–13 ms / 13–18 ms / 14 |

Findings:

- **Re-rendering every message was the cost, and memo removes it.** A streaming tick now renders
  only the messages that changed. The render work left in the window (about 110 ms over 15–16
  commits) was not split by subtree: it covers `ChatPanel` and its other children as well as the
  row loop above.
- **content-visibility is not adopted.** It pays off only when every mounted row is laid out
  again, such as a window or sidebar width change. On the common path, scrolling up through the
  history, it adds layout as rows come on screen. With 20-row pages, mounted rows stay in the tens
  to low hundreds. Paint containment also clips what overflows a row, and it makes each row a
  stacking context. Streamdown's table copy and download menus (`absolute top-full`, not portaled)
  under a short table at the end of a message would be cut off or covered by the next row. In
  chromium, an absolutely positioned child past a `content-visibility: auto` box is not
  hit-testable unless `overflow-clip-margin` is set.
- **Virtualization is not reintroduced.** After memo, mounting more rows costs about 0.017 ms per
  row per commit. The 2026-09-25 reasons against it (heights that keep changing while Markdown
  streams, `measureElement`) still hold. Look at it again only if people keep many hundreds of
  rows mounted.
- **Limits.** Development build; the frames arrive in one SSE body; render counts and React
  render time include every commit in the window, not only the history subtree; CDP counters are
  process-wide, so small layout and style counts can move by one or two between runs.
