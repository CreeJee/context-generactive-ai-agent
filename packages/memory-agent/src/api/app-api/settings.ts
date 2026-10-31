import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { KanbanConcurrency, SummaryStartPercent } from "../../config/contracts.ts";
import { KagiStatus } from "../../kagi/contracts.ts";
import { appRefusalFields, refusalWith, SameSite } from "../refusal.ts";

const appRefusal = refusalWith(appRefusalFields);

/** When long conversations start being summarized, as a percent of the context window. */
export const ConversationSettings = Schema.Struct({ summaryStartPercent: SummaryStartPercent });
export type ConversationSettings = typeof ConversationSettings.Type;

/** Which memory a run may reach beyond its own project; both start off. */
export const RecallSettings = Schema.Struct({
  crossProjectRecall: Schema.Boolean,
  externalAgentMemory: Schema.Boolean,
});
export type RecallSettings = typeof RecallSettings.Type;

/**
 * Kanban cards run at once across every Goal: the user's value, if any, and the one in use; and
 * the projects in the order the scheduler serves them.
 */
export const KanbanSettings = Schema.Struct({
  configured: Schema.NullOr(KanbanConcurrency),
  effective: Schema.Int,
  projectOrder: Schema.Array(Schema.String),
});
export type KanbanSettings = typeof KanbanSettings.Type;

/** A user value, or null to go back to the machine default; or a project's place in the tree. */
export const KanbanSettingsCommand = Schema.TaggedUnion({
  SetConcurrency: { concurrency: Schema.NullOr(KanbanConcurrency) },
  /** The project goes in front of `before`, or last. */
  MoveProject: { projectId: Schema.String, before: Schema.NullOr(Schema.String) },
});
export type KanbanSettingsCommand = typeof KanbanSettingsCommand.Type;

/**
 * - `register` { key }: stores the key in the OS keychain; does not turn Kagi on.
 * - `enable` / `disable`: turns Search and Extract on or off for every project.
 * - `remove`: deletes the key and turns Kagi off.
 */
export const KagiCommand = Schema.TaggedUnion({
  register: { key: Schema.Trim.pipe(Schema.check(Schema.isNonEmpty())) },
  remove: {},
  enable: {},
  disable: {},
});
export type KagiCommand = typeof KagiCommand.Type;

/** Reading or writing the settings file failed. */
const SettingsFailed = appRefusal(500, ["settings_failed"]);

const KanbanRefusals = [
  appRefusal(400, ["invalid_kanban_settings"]),
  appRefusal(404, ["project_not_found"]),
  appRefusal(500, [
    "settings_failed",
    "storage_failed",
    "schedule_storage_failed",
    "kanban_storage_failed",
  ]),
] as const;

/** `reason` is the keychain operation that failed. */
const KagiRefusals = [
  appRefusal(409, ["kagi_key_required"]),
  appRefusal(500, ["keychain_failed", "settings_failed"]),
] as const;

/** Every refusal of the group, for `appRefusalStatus`. */
export const settingsRefusals = [SettingsFailed, ...KanbanRefusals, ...KagiRefusals];

/** User-wide settings (`/api/settings/*`). */
export class SettingsGroup extends HttpApiGroup.make("settings")
  .add(
    /** When long conversations start being summarized. */
    HttpApiEndpoint.get("conversation", "/api/settings/conversation", {
      success: ConversationSettings,
      error: SettingsFailed,
    }),
    /** The share of the context window, 0-50 percent; applies from the next run. */
    HttpApiEndpoint.post("setConversation", "/api/settings/conversation", {
      payload: ConversationSettings,
      success: ConversationSettings,
      error: SettingsFailed,
    }),
    /** Which memory a run may reach beyond its own project. */
    HttpApiEndpoint.get("recall", "/api/settings/recall", {
      success: RecallSettings,
      error: SettingsFailed,
    }),
    /**
     * Search other projects' memory too; send matching memory to external agents in direct
     * conversations. A setting left out stays as it is.
     */
    HttpApiEndpoint.post("setRecall", "/api/settings/recall", {
      payload: Schema.Struct({
        crossProjectRecall: Schema.optional(Schema.Boolean),
        externalAgentMemory: Schema.optional(Schema.Boolean),
      }),
      success: RecallSettings,
      error: SettingsFailed,
    }),
    /** How many kanban cards run at once, and the order of projects in the priority tree. */
    HttpApiEndpoint.get("kanban", "/api/settings/kanban", {
      success: KanbanSettings,
      error: KanbanRefusals,
    }),
    /**
     * The card queue applies a new concurrency at once; running cards are not stopped. Moving a
     * project makes every board look again.
     */
    HttpApiEndpoint.post("setKanban", "/api/settings/kanban", {
      payload: KanbanSettingsCommand,
      success: KanbanSettings,
      error: KanbanRefusals,
    }),
    /** Whether a key is registered and Kagi is on. The key is never returned (R19). */
    HttpApiEndpoint.get("kagi", "/api/settings/kagi", {
      success: KagiStatus,
      error: KagiRefusals,
    }),
    HttpApiEndpoint.post("kagiAction", "/api/settings/kagi", {
      payload: KagiCommand,
      success: KagiStatus,
      error: KagiRefusals,
    }),
  )
  .middleware(SameSite) {}
