import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Schedule,
  Schema,
} from "effect";
import { Exit, Scope } from "effect";
import { PersistedQueue } from "effect/persistence";
import { SqlClient } from "effect/sql";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { Database } from "../db/database.ts";
import {
  PersistedQueueItems,
  PersistedQueueItemsReason,
  persistedQueueStoreLayer,
} from "./persisted-queue-store.ts";

class CardRunFailed extends Schema.TaggedError<CardRunFailed, { readonly brand: unique symbol }>()(
  "CardRunFailed",
  {},
) {}

const Card = Schema.Struct({ cardId: Schema.String });
const queueOptions = {
  name: "cards",
  schema: Card,
  maxAttempts: 2,
  retrySchedule: Schedule.spaced(Duration.zero),
};

/** One owner process: its own connection to the shared file, store and factory. */
const openOwner = (file: string, scope: Scope.Scope) =>
  Layer.buildWithScope(
    PersistedQueue.layer.pipe(
      Layer.provideMerge(persistedQueueStoreLayer()),
      Layer.provideMerge(Layer.merge(Database.layer(file), NodeCrypto.layer)),
    ),
    scope,
  ).pipe(
    Effect.map((context) => ({
      run: <A, E>(
        effect: Effect.Effect<
          A,
          E,
          PersistedQueue.PersistedQueueFactory | PersistedQueueItems | SqlClient.SqlClient
        >,
      ) => Effect.provideContext(effect, context),
    })),
  );

const databaseFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return `${yield* fs.makeTempDirectoryScoped()}/agent.db`;
}).pipe((program) =>
  Effect.flatMap(Layer.build(NodeFileSystem.layer), (context) =>
    Effect.provideContext(program, context),
  ),
);

const cards = PersistedQueue.make(queueOptions);

it.live("redelivers a card whose owner crashed before acknowledging it", () =>
  Effect.gen(function* () {
    const file = yield* databaseFile;
    const crashedScope = yield* Scope.make();
    const crashed = yield* openOwner(file, crashedScope);
    const started = yield* Deferred.make<number>();
    yield* crashed.run(
      Effect.flatMap(cards, (queue) => queue.offer({ cardId: "a" }, { id: "g:a:1" })),
    );
    // The first owner claims the card and stops inside the handler; no finalizer runs before restart.
    const stuck = yield* crashed
      .run(
        Effect.flatMap(cards, (queue) =>
          queue.take((_, { attempts }) =>
            Deferred.succeed(started, attempts).pipe(Effect.andThen(Effect.never)),
          ),
        ),
      )
      .pipe(Effect.forkDetach);
    expect(yield* Deferred.await(started)).toBe(1);

    const restarted = yield* openOwner(file, yield* Effect.scope);
    const delivered = yield* restarted.run(
      Effect.flatMap(cards, (queue) => queue.take((card, meta) => Effect.succeed({ card, meta }))),
    );
    expect(delivered).toEqual({ card: { cardId: "a" }, meta: { id: "g:a:1", attempts: 2 } });

    // The old owner's late finalizer must not overwrite what the new owner settled.
    yield* Fiber.interrupt(stuck);
    yield* Scope.close(crashedScope, Exit.void);
    const status = yield* restarted.run(
      PersistedQueueItems.use((queue) => queue.status("cards", "g:a:1")),
    );
    expect(
      Option.map(status, ({ state, attempts, claimed }) => ({ state, attempts, claimed })),
    ).toEqual(Option.some({ state: "completed", attempts: 2, claimed: false }));
  }).pipe(Effect.scoped),
);

it.live("dead-letters an undecodable payload and delivers the next card as itself", () =>
  Effect.gen(function* () {
    const owner = yield* openOwner(yield* databaseFile, yield* Effect.scope);
    yield* owner.run(
      Effect.gen(function* () {
        const queue = yield* cards;
        yield* queue.offer({ cardId: "x" }, { id: "g:x:1" });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE persisted_queue_items SET element_json = 'not json' WHERE id = 'g:x:1'`;
        yield* queue.offer({ cardId: "y" }, { id: "g:y:1" });
      }),
    );
    const delivered = yield* owner.run(
      Effect.flatMap(cards, (queue) => queue.take((card, meta) => Effect.succeed({ card, meta }))),
    );
    expect(delivered).toEqual({ card: { cardId: "y" }, meta: { id: "g:y:1", attempts: 1 } });
  }).pipe(Effect.scoped),
);

it.live("dead-letters a card after its attempts, keeps it across restart and requeues it", () =>
  Effect.gen(function* () {
    const file = yield* databaseFile;
    const firstScope = yield* Scope.make();
    const first = yield* openOwner(file, firstScope);
    const fail = Effect.flatMap(cards, (queue) =>
      queue.take(() => Effect.fail(CardRunFailed.make({}))).pipe(Effect.flip),
    );
    yield* first.run(
      Effect.gen(function* () {
        const queue = yield* cards;
        yield* queue.offer({ cardId: "b" }, { id: "g:b:1" });
        yield* queue.offer({ cardId: "c" }, { id: "g:c:1" });
      }),
    );
    // Two attempts each, oldest first; retries become visible at once with a zero delay.
    expect(yield* first.run(Effect.all([fail, fail, fail, fail]))).toHaveLength(4);
    yield* Scope.close(firstScope, Exit.void);

    const second = yield* openOwner(file, yield* Effect.scope);
    const deadLetters = yield* second.run(
      PersistedQueueItems.use((queue) => queue.deadLetters("cards")),
    );
    expect(
      deadLetters.map(({ id, attempts, lastFailure }) => ({ id, attempts, lastFailure })),
    ).toEqual([
      { id: "g:b:1", attempts: 2, lastFailure: "CardRunFailed" },
      { id: "g:c:1", attempts: 2, lastFailure: "CardRunFailed" },
    ]);

    yield* second.run(PersistedQueueItems.use((queue) => queue.requeue("cards", "g:c:1")));
    const requeued = yield* second.run(
      Effect.flatMap(cards, (queue) =>
        queue.take((card, { attempts }) => Effect.succeed({ card, attempts })),
      ),
    );
    expect(requeued).toEqual({ card: { cardId: "c" }, attempts: 1 });

    const refused = yield* second.run(
      PersistedQueueItems.use((queue) =>
        Effect.all([
          Effect.flip(queue.requeue("cards", "g:c:1")),
          Effect.flip(queue.requeue("cards", "missing")),
        ]),
      ),
    );
    expect(refused.map(({ reason }) => reason)).toEqual([
      PersistedQueueItemsReason.cases.NotDeadLettered.make({ state: "completed" }),
      PersistedQueueItemsReason.cases.NotFound.make({}),
    ]);
  }).pipe(Effect.scoped),
);
