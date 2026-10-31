import { Schema } from "effect";
import { HttpApi } from "effect/http-api";
import { BtwThreadsGroup, btwRefusals } from "./app-api/btw.ts";
import { EventsGroup } from "./app-api/events.ts";
import { MediaGroup, mediaRefusals } from "./app-api/media.ts";
import { ProjectsGroup, projectsRefusals } from "./app-api/projects.ts";
import { ReportsGroup, reportsRefusals } from "./app-api/reports.ts";
import { AccountsGroup, AuthGroup, ModelsGroup, providersRefusals } from "./app-api/providers.ts";
import { SessionsGroup, sessionsRefusals } from "./app-api/sessions.ts";
import { SettingsGroup, settingsRefusals } from "./app-api/settings.ts";
import { TraceGroup, traceRefusals } from "./app-api/trace.ts";
import { refusalStatusIn, SameSiteRefusal } from "./refusal.ts";

/**
 * The app's API besides chat (docs/httpapi-migration.md), declared once for the server and the
 * page. Each group is a module of `app-api/`. This module imports no server code, so the browser
 * bundle can use it.
 */
export class AppApi extends HttpApi.make("app")
  .add(SettingsGroup)
  .add(ProjectsGroup)
  .add(AuthGroup)
  .add(AccountsGroup)
  .add(ModelsGroup)
  .add(SessionsGroup)
  .add(TraceGroup)
  .add(BtwThreadsGroup)
  .add(ReportsGroup)
  .add(MediaGroup)
  .add(EventsGroup) {}

/** Every refusal of the app API, `SameSite`'s included. */
const appRefusals = [
  SameSiteRefusal,
  ...settingsRefusals,
  ...projectsRefusals,
  ...providersRefusals,
  ...sessionsRefusals,
  ...traceRefusals,
  ...btwRefusals,
  ...reportsRefusals,
  ...mediaRefusals,
];

/**
 * The HTTP status an app API refusal is answered with. A code has one status across the groups, so
 * the page reads it from the refusal alone. `auth_failed` has two, told apart by its reason, and
 * `provider_unavailable` two, told apart by its `provider`.
 */
export const appRefusalStatus = refusalStatusIn(appRefusals);

/** Every code an app API refusal carries under `error`. */
export const AppRefusalCode = Schema.Union(appRefusals.map((refusal) => refusal.fields.error));
export type AppRefusalCode = typeof AppRefusalCode.Type;

export {
  ConversationSettings,
  EmbeddingCommand,
  ImageSettings,
  ImageSettingsCommand,
  ImportCommand,
  ImprovementStatus,
  KagiCommand,
  KanbanSettings,
  KanbanSettingsCommand,
  RecallSettings,
  ScanCommand,
} from "./app-api/settings.ts";
export {
  ExternalAgentCommand,
  McpCommand,
  ProjectKanbanCommand,
  ProjectKanbanSettings,
  ProjectSettings,
} from "./app-api/projects.ts";
export {
  CompatibleAccountCommand,
  CompatibleModelList,
  CompatibleTestResult,
  ModelCatalogView,
  SubscriptionAccountCommand,
} from "./app-api/providers.ts";
export {
  CreateSession,
  DecisionAnswerInput,
  KanbanCommand,
  KanbanView,
  SessionChange,
  SubagentTranscript,
} from "./app-api/sessions.ts";
export {
  deliveryFailureStatus,
  diagnosisFailureStatus,
  ReportDeliveryCommand,
} from "./app-api/reports.ts";
export { GeneratedImage } from "./app-api/media.ts";
export { CrossProviderMediaRunApproval } from "../providers/image-media-contracts.ts";
export { AppChangedEvent, AppReadyEvent } from "../events/contracts.ts";
export { Session } from "../sessions/contracts.ts";
export { LifecycleResult, ResumeTaskResult } from "../work-trace/contracts.ts";
export { WorkflowState } from "../workflow/contracts.ts";
export { FolderPick } from "../projects/contracts.ts";
export {
  SubscriptionAccountsView,
  SubscriptionQuotaReport,
  type AccountLoginState,
  type OAuthProfile,
} from "../oauth/contracts.ts";
export { ProviderAuthState } from "../providers/contracts.ts";
export { NoStore } from "./no-store.ts";
