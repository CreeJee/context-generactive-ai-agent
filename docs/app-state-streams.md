# App state streams

The browser uses three different streaming paths. They solve different problems and must not be merged accidentally.

## Stream roles

| Stream           | Transport                                                          | Source of truth                         | Purpose                                                                                       |
| ---------------- | ------------------------------------------------------------------ | --------------------------------------- | --------------------------------------------------------------------------------------------- |
| TanStack AI chat | fetch-based SSE (`/api/chat`)                                      | persisted chat/run state                | Model output, tool interrupts, and chat custom events for one active run.                     |
| Work Trace       | durable cursor SSE (`/api/sessions/:session/trace/stream`)         | durable Work Trace events               | Ordered, replayable task/attempt/evidence activity. Reconnect resumes from its cursor.        |
| App invalidation | native `EventSource` (`/api/events`, project and session variants) | REST snapshots cached by TanStack Query | Lightweight `scope` + `topic` + `revision` wake-ups. Payloads do not carry application state. |

App invalidation events are deliberately ephemeral. A `ready` frame causes the corresponding query scope to refetch, so opening the stream after the initial snapshot, reconnecting after a gap, or restarting the backend converges on the authoritative REST snapshot. A malformed event is ignored and reported locally; native `EventSource` performs transport reconnects.

## Scope and connection lifecycle

Query keys are hierarchical: global, project, session, then resource. Events invalidate only the matching key or scope root.

- One project stream is open for the selected project.
- One session stream is open for the selected session.
- One global stream is open only while Settings is open or an OAuth login is pending.
- Changing selection or closing Settings aborts the provider and closes its `EventSource`.
- Session event invalidations are coalesced for 50 ms and duplicate/older revisions are ignored.
- The session owner lease renewal remains a 20-second heartbeat. Retry/backoff, edit debounce, and the importer's five-minute source schedule are not app-state polling and remain unchanged.

Normal conversation view therefore has **2 app invalidation EventSources**. Settings raises that to **3**. The Work Trace hook adds its durable stream, opening the Work Trace panel may add its panel stream, and an active chat adds the fetch-based chat stream. This inventory matters on HTTP/1.1, where the busiest view can approach the per-origin connection limit; HTTP/2 is preferred. If another persistent stream is added, multiplex or remove an existing connection rather than adding a widget-local EventSource.

## Request-rate change

Removed timers had these rates while their conditions were active:

- active run queue: every 1.5 s = 40 GET/min;
- detached/cancelling run/workflow snapshot: every 2 s = 30 GET/min;
- active run delegated work: every 1.5 s, with two GETs each time = 80 GET/min;
- read-only lease observation: every 3 s = 20 GET/min;
- untitled session list refresh: every 1 s = 60 GET/min until titled;
- OAuth pending: every 2 s = 30 GET/min per pending provider;
- import progress: every 1 s while reading = 60 GET/min, then every 3 s while indexing = 20 GET/min;
- embedding check/index progress: every 3 s = 20 GET/min.

With app invalidation SSE, an idle selected session makes no periodic snapshot GETs. A producer event causes one topic-scoped refetch after the 50 ms coalescing window. Import and embedding batches publish progress events, so their request rate follows actual work rather than elapsed wall time. Native SSE heartbeat frames every 15 seconds keep intermediaries from treating an idle connection as abandoned but do not trigger queries.

## Failure and fallback policy

1. **Initial snapshot/open race:** `ready` invalidates the whole active scope and refetches it.
2. **Temporary disconnect:** native `EventSource` reconnects; the next `ready` refetches the scope.
3. **Backend restart:** in-memory revisions reset, but `ready` still refetches durable snapshots, so revision continuity is not required across processes.
4. **Dropped or burst events:** REST remains authoritative; 50 ms batching coalesces keys, and reconnect `ready` repairs missed changes.
5. **Malformed payload:** schema decoding rejects only that frame. The connection stays open.
6. **Slow browser:** publishing only enqueues small frames; state is never read from the event payload. A later ready/refetch repairs transport loss.
7. **Persistent SSE failure:** expose reconnecting state and use explicit user refresh/reopen as the short-term fallback. Do not silently restore high-frequency polling. A future long-poll fallback must be centralized in the provider and guarded by measured failure rates.

## Verification

The focused contract suite covers scope isolation, malformed-frame tolerance, abort cleanup, and the topic-to-query invalidation matrix. Before release run:

```sh
pnpm exec vp check
pnpm exec vp test
pnpm build
```

A source audit should find no general browser `setInterval` polling under `apps/agent/app/entry`; `session-lease.ts` is the intentional owner heartbeat exception.
