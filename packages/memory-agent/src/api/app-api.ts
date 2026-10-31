import { HttpApi } from "effect/http-api";
import { ProjectsGroup, projectsRefusals } from "./app-api/projects.ts";
import { AccountsGroup, AuthGroup, ModelsGroup, providersRefusals } from "./app-api/providers.ts";
import { SessionsGroup, sessionsRefusals } from "./app-api/sessions.ts";
import { SettingsGroup, settingsRefusals } from "./app-api/settings.ts";
import { refusalStatusIn } from "./refusal.ts";

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
  .add(SessionsGroup) {}

/**
 * The HTTP status an app API refusal is answered with. A code has one status across the groups, so
 * the page reads it from the refusal alone; `auth_failed` alone has two, told apart by its reason.
 */
export const appRefusalStatus = refusalStatusIn([
  ...settingsRefusals,
  ...projectsRefusals,
  ...providersRefusals,
  ...sessionsRefusals,
]);

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
  SubagentTranscript,
} from "./app-api/sessions.ts";
export { FolderPick } from "../projects/contracts.ts";
export {
  SubscriptionAccountsView,
  SubscriptionQuotaReport,
  type AccountLoginState,
  type OAuthProfile,
} from "../oauth/contracts.ts";
export { ProviderAuthState } from "../providers/contracts.ts";
export { NoStore } from "./no-store.ts";
