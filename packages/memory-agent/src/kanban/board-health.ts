import { Context, Effect, Layer, Predicate, Ref } from "effect";
import { AppEvents } from "../events/app-events.ts";
import {
  healthyLoop,
  loopStopped,
  sameLoopHealth,
  superviseLoopStep,
  type LoopHealth,
} from "../runtime/loop-health.ts";

/** The board a loop step belongs to. */
export interface BoardRef {
  readonly sessionId: string;
  readonly goalInstanceId: string;
}

const make = Effect.gen(function* () {
  const events = yield* AppEvents;
  // In memory: a restarted owner starts every board's loop again, healthy.
  const health = yield* Ref.make<Readonly<Record<string, LoopHealth>>>({});

  const changed = (board: BoardRef, isChanged: boolean) =>
    Effect.asVoid(
      Effect.when(events.publishSession(board.sessionId, "run-state"), Effect.succeed(isChanged)),
    );

  const get = (goalInstanceId: string) =>
    Effect.map(Ref.get(health), (all) => all[goalInstanceId] ?? healthyLoop);

  /**
   * Records the health one of the board's steps reports. A stopped board keeps its health until it
   * is restarted, so a step of it ending meanwhile cannot hide why it stopped.
   */
  const set = (board: BoardRef, next: LoopHealth) =>
    Ref.modify(health, (all): [boolean, Readonly<Record<string, LoopHealth>>] => {
      const current = all[board.goalInstanceId] ?? healthyLoop;
      return loopStopped(current) || sameLoopHealth(current, next)
        ? [false, all]
        : [true, { ...all, [board.goalInstanceId]: next }];
    }).pipe(Effect.flatMap((isChanged) => changed(board, isChanged)));

  return {
    get,

    /** Clears a stopped board's health so its loop can run again. */
    restart: (board: BoardRef) =>
      Ref.modify(health, (all): [boolean, Readonly<Record<string, LoopHealth>>] => {
        const { [board.goalInstanceId]: previous, ...rest } = all;
        return [previous !== undefined && !Predicate.isTagged(previous, "Healthy"), rest];
      }).pipe(Effect.flatMap((isChanged) => changed(board, isChanged))),

    /** Runs one step of the board's loop, or of a step beside it, under the loop retry policy. */
    supervise: (board: BoardRef, message: string, annotations: Readonly<Record<string, string>>) =>
      superviseLoopStep({
        message,
        annotations: { goalInstanceId: board.goalInstanceId, ...annotations },
        setHealth: (next) => set(board, next),
      }),
  };
});

/**
 * How each kanban board's loop stands (decided 2026-10-18): the board loop and the integration
 * and merge steps beside it report here, and the board view shows it. A stopped board waits for a
 * person to restart it.
 */
export class BoardHealth extends Context.Service<BoardHealth, Effect.Success<typeof make>>()(
  "memory-agent/kanban/board-health/BoardHealth",
) {
  static readonly layer = Layer.effect(BoardHealth, make);
}
