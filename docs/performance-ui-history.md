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
