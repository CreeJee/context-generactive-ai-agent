import { Effect, Match, Option, Path } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { SqlClient } from "effect/sql";
import {
  AppEvents,
  CrossProviderMediaConsent,
  EmbeddingSetup,
  GlobalConfig,
  GoalOrder,
  ImageFeature,
  Importer,
  Kagi,
  KanbanSettings,
  ProjectImprovement,
  ProjectScheduler,
  Projects,
  TurnSummaries,
} from "memory-agent";
import { AppApi } from "memory-agent/app-api";

const settingsFailed = () => Effect.fail({ error: "settings_failed" } as const);
// Storage failures are answered with a fixed code; the cause stays on the server.
const scheduleStorageFailed = () => Effect.fail({ error: "schedule_storage_failed" } as const);
const storageFailed = () => Effect.fail({ error: "storage_failed" } as const);
const keychainFailed = ({ operation }: { readonly operation: string }) =>
  Effect.fail({ error: "keychain_failed", reason: operation } as const);

const recallView = (settings: {
  readonly crossProjectRecall?: boolean;
  readonly externalAgentMemory?: boolean;
}) => ({
  crossProjectRecall: settings.crossProjectRecall === true,
  externalAgentMemory: settings.externalAgentMemory === true,
});

/** The settings group of `AppApi` (`/api/settings/*`). */
export const SettingsApiHandlers = HttpApiBuilder.group(
  AppApi,
  "settings",
  Effect.fn(function* (handlers) {
    const summaries = yield* TurnSummaries;
    const config = yield* GlobalConfig;
    const kanban = yield* KanbanSettings;
    const goalOrder = yield* GoalOrder;
    const projects = yield* Projects;
    const scheduler = yield* ProjectScheduler;
    const events = yield* AppEvents;
    const kagi = yield* Kagi;
    const embedding = yield* EmbeddingSetup;
    const image = yield* ImageFeature;
    const mediaConsent = yield* CrossProviderMediaConsent;
    const importer = yield* Importer;
    const improvement = yield* ProjectImprovement;
    // The importer's and the embedding setup's methods still ask for these per call.
    const path = yield* Path.Path;
    const sql = yield* SqlClient.SqlClient;

    const kanbanSettings = Effect.gen(function* () {
      const concurrency = yield* kanban.concurrency;
      const projectOrder = yield* goalOrder.projects;
      return {
        configured: Option.getOrNull(concurrency.configured),
        effective: concurrency.effective,
        projectOrder,
      };
    });

    const imageSettings = Effect.gen(function* () {
      return {
        ...(yield* image.status),
        crossProviderMediaConsent: yield* mediaConsent.read,
      };
    });

    return handlers.handleAll({
      conversation: () =>
        summaries.startPercent.pipe(
          Effect.map((summaryStartPercent) => ({ summaryStartPercent })),
          Effect.catchTag("GlobalConfigFailed", settingsFailed),
        ),
      setConversation: ({ payload }) =>
        summaries.setStartPercent(payload.summaryStartPercent).pipe(
          Effect.map((summaryStartPercent) => ({ summaryStartPercent })),
          Effect.catchTag("GlobalConfigFailed", settingsFailed),
        ),
      recall: () =>
        config.read.pipe(
          Effect.map(recallView),
          Effect.catchTag("GlobalConfigFailed", settingsFailed),
        ),
      setRecall: ({ payload }) =>
        config
          .update(payload)
          .pipe(Effect.map(recallView), Effect.catchTag("GlobalConfigFailed", settingsFailed)),
      kanban: () =>
        kanbanSettings.pipe(
          Effect.catchTags({
            GlobalConfigFailed: settingsFailed,
            GoalScheduleStorageFailed: scheduleStorageFailed,
          }),
        ),
      setKanban: ({ payload }) =>
        Match.valueTags(payload, {
          SetConcurrency: ({ concurrency }) =>
            concurrency === null ? kanban.resetConcurrency : kanban.setConcurrency(concurrency),
          MoveProject: ({ projectId, before }) =>
            Effect.gen(function* () {
              yield* projects.get(projectId);
              if (before !== null) yield* projects.get(before);
              yield* scheduler.moveProject(projectId, before);
            }),
        }).pipe(
          // Other windows' kanban settings show both values, so they read them again.
          Effect.andThen(events.publishGlobal("kanban")),
          Effect.andThen(kanbanSettings),
          Effect.catchTags({
            GlobalConfigFailed: settingsFailed,
            KanbanSettingsRefused: () => Effect.fail({ error: "invalid_kanban_settings" } as const),
            ProjectNotFound: () => Effect.fail({ error: "project_not_found" } as const),
            GoalScheduleStorageFailed: scheduleStorageFailed,
            KanbanStorageFailed: () => Effect.fail({ error: "kanban_storage_failed" } as const),
            SqlError: storageFailed,
            SchemaError: storageFailed,
          }),
        ),
      kagi: () =>
        kagi.status.pipe(
          Effect.catchTags({
            SecretStoreFailed: keychainFailed,
            GlobalConfigFailed: settingsFailed,
          }),
        ),
      kagiAction: ({ payload }) =>
        Match.valueTags(payload, {
          register: ({ key }) => kagi.registerKey(key).pipe(Effect.andThen(kagi.status)),
          remove: () => kagi.removeKey.pipe(Effect.andThen(kagi.status)),
          enable: () => kagi.setEnabled(true),
          disable: () => kagi.setEnabled(false),
        }).pipe(
          Effect.catchTags({
            SecretStoreFailed: keychainFailed,
            GlobalConfigFailed: settingsFailed,
            KagiKeyMissing: () => Effect.fail({ error: "kagi_key_required" } as const),
          }),
        ),
      // These routes declared no refusals; a failure stays a 500, as before.
      embedding: () => Effect.orDie(embedding.overview),
      embeddingAction: ({ payload }) =>
        Match.valueTags(payload, {
          choose: ({ choice }) => embedding.choose(choice),
          check: () => embedding.recheck,
        }).pipe(Effect.orDie, Effect.provideService(Path.Path, path)),
      image: () => Effect.orDie(imageSettings),
      imageAction: ({ payload }) =>
        Match.valueTags(payload, {
          image_generation: ({ enabled }) => image.setImageGenerationEnabled(enabled),
          cross_provider_media: ({ mode }) =>
            mediaConsent.set(
              {
                initiatorProvider: "anthropic",
                executorProvider: "openai",
                capability: "media.image.generate",
              },
              mode,
            ),
        }).pipe(Effect.andThen(imageSettings), Effect.orDie),
      imports: () =>
        importer.overview.pipe(Effect.orDie, Effect.provideService(SqlClient.SqlClient, sql)),
      importAction: ({ payload }) =>
        Match.valueTags(payload, {
          // Answered at once; the page follows the pass through `activity`.
          run: () => importer.start,
          restart_watch: () => importer.restartWatch,
          enable: () => importer.setEnabled(true),
          disable: () => importer.setEnabled(false),
          interpret: ({ interpret }) => importer.setInterpret(interpret),
        }).pipe(
          Effect.andThen(importer.overview),
          Effect.orDie,
          Effect.provideService(SqlClient.SqlClient, sql),
        ),
      improvements: () =>
        improvement.status.pipe(
          Effect.map(({ state, scan }) => ({ state, scan: Option.getOrNull(scan) })),
          Effect.catchTag("DiscoveryFailed", ({ reason }) =>
            Effect.fail({ error: "improvement_failed", reason } as const),
          ),
        ),
      improvementScan: ({ payload }) =>
        Match.valueTags(payload, {
          start: () => improvement.start,
          stop: () => improvement.stop,
        }).pipe(Effect.map((state) => ({ state }))),
    });
  }),
);
