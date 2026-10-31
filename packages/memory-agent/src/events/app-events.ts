import { isTruthy } from "../truthy.ts";
import {
  DateTime,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  PubSub,
  Schema,
  Scope,
  Stream,
  SynchronizedRef,
} from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { aborted } from "../runtime/aborted.ts";
import { logFailure } from "../runtime/logged-failures.ts";
import type {
  AppChangedEvent,
  AppEventFrame,
  GlobalEventTopic,
  ProjectEventTopic,
  SessionEventTopic,
} from "./contracts.ts";

export type {
  AppChangedEvent,
  AppEventFrame,
  GlobalEventTopic,
  ProjectEventTopic,
  SessionEventTopic,
};

export type AppEventInput =
  | Omit<Extract<AppChangedEvent, { scope: "session" }>, "revision">
  | Omit<Extract<AppChangedEvent, { scope: "project" }>, "revision">
  | Omit<Extract<AppChangedEvent, { scope: "global" }>, "revision">;

export interface AppEventsApi {
  readonly publish: (input: AppEventInput) => Effect.Effect<AppChangedEvent>;
  /** Null when the session is unknown. A failed lookup is logged; events are advisory. */
  readonly publishSession: (
    sessionId: string,
    topic: SessionEventTopic,
  ) => Effect.Effect<AppChangedEvent | null>;
  readonly publishProject: (
    projectId: string,
    topic: ProjectEventTopic,
  ) => Effect.Effect<AppChangedEvent>;
  readonly publishGlobal: (topic: GlobalEventTopic) => Effect.Effect<AppChangedEvent>;
  readonly revision: Effect.Effect<number>;
  /**
   * A stream of the events in its scope, subscribed when the effect runs. It ends when the service
   * owner closes; whoever reads it ends it earlier by stopping.
   */
  readonly sessionStream: (sessionId: string) => Effect.Effect<Stream.Stream<AppEventFrame>>;
  readonly projectStream: (projectId: string) => Effect.Effect<Stream.Stream<AppEventFrame>>;
  readonly globalStream: Effect.Effect<Stream.Stream<AppEventFrame>>;
  readonly allStream: Effect.Effect<Stream.Stream<AppEventFrame>>;
}

const heartbeatMs = 15_000;

const make = Effect.fnUntraced(function* (options: {
  readonly projectForSession: (sessionId: string) => Effect.Effect<string | null>;
  readonly ownerSignal: AbortSignal | undefined;
}) {
  const changes = yield* PubSub.unbounded<AppChangedEvent>();
  // Numbered and published under one lock, so every subscriber gets the events in revision order.
  const revision = yield* SynchronizedRef.make(0);

  const publish = (input: AppEventInput) =>
    SynchronizedRef.modifyEffect(revision, (current) => {
      const nextRevision = current + 1;
      const event: AppChangedEvent =
        input.scope === "session"
          ? { ...input, revision: nextRevision }
          : input.scope === "project"
            ? { ...input, revision: nextRevision }
            : { ...input, revision: nextRevision };
      return Effect.as(PubSub.publish(changes, event), [event, nextRevision] as const);
    });

  const ownerClosed =
    options.ownerSignal === undefined ? Effect.never : aborted(options.ownerSignal);

  const stream = Effect.fnUntraced(function* (accepts: (event: AppChangedEvent) => boolean) {
    // Subscribed before the stream is handed over, so an event published right after it is not
    // lost; subscribing and reading the revision the page starts from take the publishing lock.
    const subscribed = yield* Scope.make();
    const [subscription, current] = yield* SynchronizedRef.modifyEffect(revision, (current) =>
      Effect.map(
        PubSub.subscribe(changes),
        (subscription) => [[subscription, current] as const, current] as const,
      ),
    ).pipe(Effect.provideService(Scope.Scope, subscribed));
    const heartbeats = Stream.fromEffectRepeat(
      Effect.sleep(heartbeatMs).pipe(
        Effect.andThen(DateTime.now),
        Effect.map((now): AppEventFrame => ({
          event: "heartbeat",
          data: { at: DateTime.toEpochMillis(now) },
        })),
      ),
    );
    return Stream.succeed<AppEventFrame>({ event: "ready", data: { revision: current } }).pipe(
      Stream.concat(
        Stream.merge(
          Stream.fromSubscription(subscription).pipe(
            Stream.filter(accepts),
            Stream.map((event): AppEventFrame => ({
              id: `${event.revision}`,
              event: "changed",
              data: event,
            })),
          ),
          heartbeats,
        ),
      ),
      Stream.interruptWhen(ownerClosed),
      Stream.ensuring(Scope.close(subscribed, Exit.void)),
    );
  });

  return {
    publish,
    publishSession: (sessionId: string, topic: SessionEventTopic) =>
      Effect.flatMap(options.projectForSession(sessionId), (projectId) =>
        isTruthy(projectId)
          ? publish({ scope: "session", projectId, sessionId, topic })
          : Effect.succeed(null),
      ),
    publishProject: (projectId: string, topic: ProjectEventTopic) =>
      publish({ scope: "project", projectId, topic }),
    publishGlobal: (topic: GlobalEventTopic) => publish({ scope: "global", topic }),
    revision: SynchronizedRef.get(revision),
    sessionStream: (sessionId: string) =>
      stream((event) => event.scope === "session" && event.sessionId === sessionId),
    projectStream: (projectId: string) =>
      stream((event) => event.scope === "project" && event.projectId === projectId),
    globalStream: stream((event) => event.scope === "global"),
    allStream: stream(() => true),
  } satisfies AppEventsApi;
});

const create = Effect.fnUntraced(function* (
  projectForSession: (sessionId: string) => Effect.Effect<string | null>,
) {
  const ownerScope = yield* Effect.serviceOption(Scope.Scope);
  const ownerSignal = Option.isSome(ownerScope)
    ? yield* Effect.provideService(Effect.abortSignal, Scope.Scope, ownerScope.value)
    : undefined;
  return yield* make({ projectForSession, ownerSignal });
});

export const makeAppEvents: Effect.Effect<AppEventsApi> = create(() => Effect.succeed(null));

const liveAppEvents = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projectOf = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ project_id: Schema.String }),
    execute: (sessionId) => sql`SELECT project_id FROM sessions WHERE id = ${sessionId}`,
  });
  return yield* create((sessionId) =>
    projectOf(sessionId).pipe(
      Effect.map((row) => Option.getOrNull(Option.map(row, ({ project_id }) => project_id))),
      // A missed hint only delays a page's reload; the change it announces is already stored.
      Effect.catch((error) =>
        Effect.as(logFailure("Session event was not published")(error), null),
      ),
    ),
  );
});

export class AppEvents extends Context.Service<AppEvents, AppEventsApi>()(
  "memory-agent/events/app-events/AppEvents",
) {
  static readonly layer = Layer.effect(AppEvents, liveAppEvents);
}
