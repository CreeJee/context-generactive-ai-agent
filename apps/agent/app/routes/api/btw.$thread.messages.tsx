import { serveChatApi } from "~/.server/chat-api";
import type { Route } from "./+types/btw.$thread.messages";

/** GET /api/btw/:thread/messages — the chat API's BTW `messages` (`memory-agent/chat-api`). */
export function loader({ request }: Route.LoaderArgs) {
  return serveChatApi(request);
}
