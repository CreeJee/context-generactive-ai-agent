import { serveChatApi } from "~/.server/chat-api";
import type { Route } from "./+types/sessions.$session.messages";

/** GET /api/sessions/:session/messages — the chat API's `snapshot` (`memory-agent/chat-api`). */
export function loader({ request }: Route.LoaderArgs) {
  return serveChatApi(request);
}
