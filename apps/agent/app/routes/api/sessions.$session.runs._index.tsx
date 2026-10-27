import { serveChatApi } from "~/.server/chat-api";
import type { Route } from "./+types/sessions.$session.runs._index";

/** POST /api/sessions/:session/runs — the chat API's `run` (`memory-agent/chat-api`). */
export function action({ request }: Route.ActionArgs) {
  return serveChatApi(request);
}
