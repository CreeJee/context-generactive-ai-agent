import { Result, Function as EffectFunction } from "effect";
import { isTruthy } from "../truthy.ts";
import {
  Cause,
  DateTime,
  Context,
  Effect,
  Layer,
  Option,
  Queue,
  Schema,
  Scope,
  Stream,
} from "effect";
import { Database } from "../db/database.ts";

export type SessionEventTopic = "all" | "run-state" | "queue" | "subagents" | "relayed-approvals";
export type ProjectEventTopic = "all" | "sessions";
export type GlobalEventTopic = "all" | "auth" | "imports" | "embedding" | "projects";

export type AppChangedEvent =
  | {
      readonly scope: "session";
      readonly projectId: string;
      readonly sessionId: string;
      readonly topic: SessionEventTopic;
      readonly revision: number;
    }
  | {
      readonly scope: "project";
      readonly projectId: string;
      readonly topic: ProjectEventTopic;
      readonly revision: number;
    }
  | {
      readonly scope: "global";
      readonly topic: GlobalEventTopic;
      readonly revision: number;
    };

export type AppEventInput =
  | Omit<Extract<AppChangedEvent, { scope: "session" }>, "revision">
  | Omit<Extract<AppChangedEvent, { scope: "project" }>, "revision">
  | Omit<Extract<AppChangedEvent, { scope: "global" }>, "revision">;

export interface AppEventsApi {
  readonly publish: (input: AppEventInput) => AppChangedEvent;
  readonly publishSession: (sessionId: string, topic: SessionEventTopic) => AppChangedEvent | null;
  readonly publishProject: (projectId: string, topic: ProjectEventTopic) => AppChangedEvent;
  readonly publishGlobal: (topic: GlobalEventTopic) => AppChangedEvent;
  readonly revision: () => number;
  readonly sessionStream: (request: Request, sessionId: string) => Response;
  readonly projectStream: (request: Request, projectId: string) => Response;
  readonly globalStream: (request: Request) => Response;
  readonly allStream: (request: Request) => Response;
}

type SsePayload = AppChangedEvent | { readonly revision: number } | { readonly at: number };

const encoder = new TextEncoder();
const heartbeatMs = 15_000;

const frame = (event: string, payload: SsePayload, id?: number) =>
  `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

const make = (options: {
  readonly projectForSession: (sessionId: string) => string | null;
  readonly context: Context.Context<never>;
  readonly ownerSignal: AbortSignal | undefined;
}): AppEventsApi => {
  const target = new EventTarget();
  let revision = 0;

  const publish = (input: AppEventInput) => {
    const nextRevision = ++revision;
    const event: AppChangedEvent =
      input.scope === "session"
        ? { ...input, revision: nextRevision }
        : input.scope === "project"
          ? { ...input, revision: nextRevision }
          : { ...input, revision: nextRevision };
    target.dispatchEvent(new CustomEvent("changed", { detail: event }));
    return event;
  };

  const stream = (request: Request, accepts: (event: AppChangedEvent) => boolean) => {
    // Native publication is synchronous: register before returning the response so an event
    // published immediately after subscription cannot fall between registration and a fiber start.
    const queue = Effect.runSyncWith(options.context)(Queue.make<string, Cause.Done>());
    const onChanged = (raw: Event) => {
      // SAFETY: only publish above dispatches this CustomEvent.
      const event = (raw as CustomEvent<AppChangedEvent>).detail;
      if (accepts(event)) Queue.offerUnsafe(queue, frame("changed", event, event.revision));
    };
    const close = () => {
      Queue.endUnsafe(queue);
    };
    target.addEventListener("changed", onChanged);
    request.signal.addEventListener("abort", close, { once: true });
    options.ownerSignal?.addEventListener("abort", close, { once: true });
    if (request.signal.aborted || options.ownerSignal?.aborted === true) close();
    else Queue.offerUnsafe(queue, frame("ready", { revision }));
    const frames = Stream.unwrap(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            target.removeEventListener("changed", onChanged);
            request.signal.removeEventListener("abort", close);
            options.ownerSignal?.removeEventListener("abort", close);
            Queue.shutdownUnsafe(queue);
          }),
        );
        yield* Effect.forever(
          Effect.gen(function* () {
            yield* Effect.sleep(heartbeatMs);
            const now = yield* DateTime.now;
            yield* Queue.offer(queue, frame("heartbeat", { at: DateTime.toEpochMillis(now) }));
          }),
        ).pipe(Effect.forkIn(yield* Scope.Scope));
        return Stream.fromQueue(queue);
      }),
    );
    const body = Stream.toReadableStreamWith(
      frames.pipe(Stream.map((value) => encoder.encode(value))),
      options.context,
    );
    return new Response(body, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream",
        "X-Accel-Buffering": "no",
      },
    });
  };

  return {
    publish,
    publishSession(sessionId: string, topic: SessionEventTopic) {
      const projectId = options.projectForSession(sessionId);
      return isTruthy(projectId)
        ? publish({ scope: "session", projectId, sessionId, topic })
        : null;
    },
    publishProject: (projectId: string, topic: ProjectEventTopic) =>
      publish({ scope: "project", projectId, topic }),
    publishGlobal: (topic: GlobalEventTopic) => publish({ scope: "global", topic }),
    revision: () => revision,
    sessionStream: (request: Request, sessionId: string) =>
      stream(request, (event) => event.scope === "session" && event.sessionId === sessionId),
    projectStream: (request: Request, projectId: string) =>
      stream(request, (event) => event.scope === "project" && event.projectId === projectId),
    globalStream: (request: Request) => stream(request, (event) => event.scope === "global"),
    allStream: (request: Request) => stream(request, () => true),
  };
};

const create = Effect.fnUntraced(function* (
  projectForSession: (sessionId: string) => string | null,
) {
  const context = yield* Effect.context<never>();
  const ownerScope = yield* Effect.serviceOption(Scope.Scope);
  const ownerSignal = Option.isSome(ownerScope)
    ? yield* Effect.provideService(Effect.abortSignal, Scope.Scope, ownerScope.value)
    : undefined;
  return make({ projectForSession, context, ownerSignal });
});

export const makeAppEvents: Effect.Effect<AppEventsApi> = create(() => null);

const liveAppEvents = Effect.gen(function* () {
  const { sqlite } = yield* Database;
  // Synchronous codec at the native DTO/SQLite boundary; validation failures remain with the boundary caller.
  const decodeProject = EffectFunction.flow(
    Schema.decodeUnknownResult(Schema.Struct({ project_id: Schema.String })),
    Result.getOrThrow,
  );
  const statement = sqlite.prepare("SELECT project_id FROM sessions WHERE id = ?");
  return yield* create((sessionId) => {
    const row = statement.get(sessionId);
    return isTruthy(row) ? decodeProject(row).project_id : null;
  });
});

export class AppEvents extends Context.Service<AppEvents, AppEventsApi>()(
  "memory-agent/events/app-events/AppEvents",
) {
  static readonly layer = Layer.effect(AppEvents, liveAppEvents);
}
