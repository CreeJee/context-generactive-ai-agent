import { agent } from "~/.server/agent";
import { makeChatHandlers } from "~/.server/chat-handlers";
const handlers = makeChatHandlers(agent);

export const action = handlers.action;
export const loader = handlers.loader;
