import { HttpApi } from "effect/http-api";
import { ProjectsGroup, projectsRefusals } from "./app-api/projects.ts";
import { SettingsGroup, settingsRefusals } from "./app-api/settings.ts";
import { refusalStatusIn } from "./refusal.ts";

/**
 * The app's API besides chat (docs/httpapi-migration.md), declared once for the server and the
 * page. Each group is a module of `app-api/`. This module imports no server code, so the browser
 * bundle can use it.
 */
export class AppApi extends HttpApi.make("app").add(SettingsGroup).add(ProjectsGroup) {}

/**
 * The HTTP status an app API refusal is answered with. A code has one status across the groups, so
 * the page reads it from the refusal alone.
 */
export const appRefusalStatus = refusalStatusIn([...settingsRefusals, ...projectsRefusals]);

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
export { FolderPick } from "../projects/contracts.ts";
