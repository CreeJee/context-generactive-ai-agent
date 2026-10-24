import { type Effect, Function as EffectFunction } from "effect";
import type { AgentChat } from "../../src/agent/chat.ts";

type Chat = AgentChat["Service"];

/** `/api/chat` as the app routes it: a POST runs a turn, anything else hydrates the page. */
export const chatRoute: {
  (request: Request, sessionId: string): (chat: Chat) => ReturnType<typeof chatRouteBody>;
} & typeof chatRouteBody = EffectFunction.dual(3, chatRouteBody);
function chatRouteBody(
  chat: Chat,
  request: Request,
  sessionId: string,
): Effect.Effect<
  Response,
  Effect.Error<ReturnType<Chat["handle"]>> | Effect.Error<ReturnType<Chat["hydrate"]>>
> {
  return request.method === "POST"
    ? chat.handle(request, sessionId)
    : chat.hydrate(request, sessionId);
}
