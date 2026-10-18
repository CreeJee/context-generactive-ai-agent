import type { Effect } from "effect";
import type { AgentChat } from "../../src/agent/chat.ts";

type Chat = AgentChat["Service"];

/** `/api/chat` as the app routes it: a POST runs a turn, anything else hydrates the page. */
export const chatRoute = (
  chat: Chat,
  request: Request,
  sessionId: string,
): Effect.Effect<
  Response,
  Effect.Error<ReturnType<Chat["handle"]>> | Effect.Error<ReturnType<Chat["hydrate"]>>
> =>
  request.method === "POST" ? chat.handle(request, sessionId) : chat.hydrate(request, sessionId);
