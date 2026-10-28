import { serveChatApi } from "~/.server/chat-api";
import type { Route } from "./+types/btw.$thread.runs";

/** POST /api/btw/:thread/runs — the chat API's BTW `ask` (`memory-agent/chat-api`). */
export function action({ request }: Route.ActionArgs) {
  return serveChatApi(request);
}
