import { Context, Effect, Layer, Option, PubSub, Schema } from "effect";
import { availableCores } from "../runtime/host-system.ts";
import { KanbanConcurrency } from "./contracts.ts";
import { GlobalConfig } from "./global-config.ts";

/** Half the cores, at least 1 and at most 4 (docs/kanban-orchestration.md). */
export const defaultKanbanConcurrency = (cores: number) =>
  Math.min(4, Math.max(1, Math.floor(cores / 2)));

export class KanbanSettingsRefused extends Schema.TaggedError<
  KanbanSettingsRefused,
  { readonly brand: unique symbol }
>()("KanbanSettingsRefused", { reason: Schema.Literals(["concurrency_out_of_range"]) }) {}

/** The user's choice when there is one, and the value cards actually run with. */
export interface KanbanConcurrencySetting {
  readonly configured: Option.Option<number>;
  readonly effective: number;
}

const make = (cores: number) =>
  Effect.gen(function* () {
    const config = yield* GlobalConfig;
    const fallback = defaultKanbanConcurrency(cores);
    const changed = yield* PubSub.unbounded<KanbanConcurrencySetting>();
    const current = Effect.map(config.read, (settings): KanbanConcurrencySetting => ({
      configured: Option.fromUndefinedOr(settings.kanbanConcurrency),
      effective: settings.kanbanConcurrency ?? fallback,
    }));
    /** Reads the saved value back and tells subscribers what cards now run with. */
    const announce = Effect.tap(current, (setting) => PubSub.publish(changed, setting));
    return {
      concurrency: current,
      /** Each saved change from here on, as cards now run with it; scoped to the subscriber. */
      changes: PubSub.subscribe(changed),
      /** Saves a user value after checking its range; the card queue gate applies it at once. */
      setConcurrency: Effect.fn("KanbanSettings.setConcurrency")(function* (value: number) {
        const checked = yield* Schema.decodeEffect(KanbanConcurrency)(value).pipe(
          Effect.mapError(() => KanbanSettingsRefused.make({ reason: "concurrency_out_of_range" })),
        );
        yield* config.update({ kanbanConcurrency: checked });
        return yield* announce;
      }),
      /** Drops the user value so the machine default applies again. */
      resetConcurrency: config
        .update({ kanbanConcurrency: undefined })
        .pipe(Effect.andThen(announce)),
    };
  });

/** Kanban execution settings kept in the global config. */
export class KanbanSettings extends Context.Service<
  KanbanSettings,
  Effect.Success<ReturnType<typeof make>>
>()("memory-agent/config/kanban-settings/KanbanSettings") {
  static readonly layer = (cores?: number) =>
    Layer.effect(
      KanbanSettings,
      Effect.flatMap(cores === undefined ? availableCores : Effect.succeed(cores), make),
    );
}
