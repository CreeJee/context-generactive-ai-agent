import { Context, Effect, Layer, Schema } from "effect";
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

const make = (projectForSession: (sessionId: string) => string | null): AppEventsApi => {
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
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const send = (value: string) => {
          if (!closed) controller.enqueue(encoder.encode(value));
        };
        const onChanged = (raw: Event) => {
          // SAFETY: this listener is registered only for CustomEvents created by publish above.
          const event = (raw as CustomEvent<AppChangedEvent>).detail;
          if (accepts(event)) send(frame("changed", event, event.revision));
        };
        const close = () => {
          if (closed) return;
          closed = true;
          if (heartbeat !== undefined) clearInterval(heartbeat);
          target.removeEventListener("changed", onChanged);
          request.signal.removeEventListener("abort", close);
          controller.close();
        };
        target.addEventListener("changed", onChanged);
        request.signal.addEventListener("abort", close, { once: true });
        if (request.signal.aborted) return close();
        send(frame("ready", { revision }));
        heartbeat = setInterval(() => send(frame("heartbeat", { at: Date.now() })), heartbeatMs);
      },
    });
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
      const projectId = projectForSession(sessionId);
      return projectId ? publish({ scope: "session", projectId, sessionId, topic }) : null;
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

export const makeAppEvents: Effect.Effect<AppEventsApi> = Effect.sync(() => make(() => null));

const liveAppEvents = Effect.map(Database, ({ sqlite }) => {
  const decodeProject = Schema.decodeUnknownSync(Schema.Struct({ project_id: Schema.String }));
  const statement = sqlite.prepare("SELECT project_id FROM sessions WHERE id = ?");
  return make((sessionId) => {
    const row = statement.get(sessionId);
    return row ? decodeProject(row).project_id : null;
  });
});

export class AppEvents extends Context.Service<AppEvents, AppEventsApi>()(
  "memory-agent/AppEvents",
) {
  static readonly layer = Layer.effect(AppEvents, liveAppEvents);
}
