import { HttpApi } from "effect/http-api";
import { SettingsGroup, settingsRefusals } from "./app-api/settings.ts";
import { refusalStatusIn } from "./refusal.ts";

/**
 * The app's API besides chat (docs/httpapi-migration.md), declared once for the server and the
 * page. Each group is a module of `app-api/`. This module imports no server code, so the browser
 * bundle can use it.
 */
export class AppApi extends HttpApi.make("app").add(SettingsGroup) {}

/**
 * The HTTP status an app API refusal is answered with. A code has one status across the groups, so
 * the page reads it from the refusal alone.
 */
export const appRefusalStatus = refusalStatusIn([...settingsRefusals]);

export {
  ConversationSettings,
  KagiCommand,
  KanbanSettings,
  KanbanSettingsCommand,
  RecallSettings,
} from "./app-api/settings.ts";
