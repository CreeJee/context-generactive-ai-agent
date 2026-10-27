import { serveChatApi } from "~/.server/chat-api";
import type { Route } from "./+types/sessions.$session.runs.$run.events";

/** GET /api/sessions/:session/runs/:run/events — the chat API's `join` (`memory-agent/chat-api`). */
export function loader({ request }: Route.LoaderArgs) {
  return serveChatApi(request);
}
