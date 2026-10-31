import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import {
  CrossProviderMediaConsentMode,
  CrossProviderMediaConsentSettings,
  EmbeddingChoice,
  KanbanConcurrency,
  SummaryStartPercent,
} from "../../config/contracts.ts";
import { ImportOverview } from "../../imports/contracts.ts";
import { ImprovementScan, ScanState } from "../../improve/contracts.ts";
import { KagiStatus } from "../../kagi/contracts.ts";
import { EmbeddingOverview } from "../../memory/embedding/contracts.ts";
import { ImageFeatureStatus } from "../../providers/contracts.ts";
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

/**
 * - `choose` { choice }: `auto`, `cpu` or `gpu`; takes effect when the app next starts.
 * - `check`: checks WebGPU again, in the background.
 */
export const EmbeddingCommand = Schema.TaggedUnion({
  choose: { choice: EmbeddingChoice },
  check: {},
});
export type EmbeddingCommand = typeof EmbeddingCommand.Type;

/** The image-generation preference and the user's consent to send media to another provider. */
export const ImageSettings = Schema.Struct({
  ...ImageFeatureStatus.fields,
  crossProviderMediaConsent: CrossProviderMediaConsentSettings,
});
export type ImageSettings = typeof ImageSettings.Type;

export const ImageSettingsCommand = Schema.TaggedUnion({
  image_generation: { enabled: Schema.Boolean },
  cross_provider_media: { mode: CrossProviderMediaConsentMode },
});
export type ImageSettingsCommand = typeof ImageSettingsCommand.Type;

/**
 * - `enable` / `disable`: keep following the transcripts. Enabling starts reading what is there now.
 * - `run`: start reading once, without changing the setting.
 * Both answer before the pass ends; `activity` in the overview reports how far it got.
 * - `restart_watch`: start the watcher again after it stopped; `watch` in the overview shows it.
 * - `interpret` { interpret }: whether migrated statements are interpreted like statements said here.
 */
export const ImportCommand = Schema.TaggedUnion({
  run: {},
  restart_watch: {},
  enable: {},
  disable: {},
  interpret: { interpret: Schema.Boolean },
});
export type ImportCommand = typeof ImportCommand.Type;

/** Where the background scan stands and the last recorded scan, or null before the first. */
export const ImprovementStatus = Schema.Struct({
  state: ScanState,
  scan: Schema.NullOr(ImprovementScan),
});
export type ImprovementStatus = typeof ImprovementStatus.Type;

export const ScanCommand = Schema.TaggedUnion({ start: {}, stop: {} });
export type ScanCommand = typeof ScanCommand.Type;

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

/** `reason` is `storage` or `report`, as the scan names it. */
const ImprovementFailed = appRefusal(500, ["improvement_failed"]);

/** Every refusal of the group, for `appRefusalStatus`. */
export const settingsRefusals = [
  SettingsFailed,
  ...KanbanRefusals,
  ...KagiRefusals,
  ImprovementFailed,
];

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
    /**
     * How the embedding model runs now and from the next start, the machine's memory, whether
     * WebGPU works, and how many nodes wait to be embedded.
     */
    HttpApiEndpoint.get("embedding", "/api/settings/embedding", { success: EmbeddingOverview }),
    HttpApiEndpoint.post("embeddingAction", "/api/settings/embedding", {
      payload: EmbeddingCommand,
      success: EmbeddingOverview,
    }),
    HttpApiEndpoint.get("image", "/api/settings/image", { success: ImageSettings }),
    /** Updates an image-generation preference without restarting the app. */
    HttpApiEndpoint.post("imageAction", "/api/settings/image", {
      payload: ImageSettingsCommand,
      success: ImageSettings,
    }),
    /**
     * What can be migrated from other coding agents' local transcripts: per source, how many
     * conversations were read, and which working directories are not projects here yet. File
     * paths are shown; transcript contents are not.
     */
    HttpApiEndpoint.get("imports", "/api/settings/imports", { success: ImportOverview }),
    HttpApiEndpoint.post("importAction", "/api/settings/imports", {
      payload: ImportCommand,
      success: ImportOverview,
    }),
    /** Where the background scan of the open projects stands, and its last recorded result. */
    HttpApiEndpoint.get("improvements", "/api/settings/improvements", {
      success: ImprovementStatus,
      error: ImprovementFailed,
    }),
    /** Starts or stops the scan; answers where it stands. */
    HttpApiEndpoint.post("improvementScan", "/api/settings/improvements", {
      payload: ScanCommand,
      success: Schema.Struct({ state: ScanState }),
    }),
  )
  .middleware(SameSite) {}
