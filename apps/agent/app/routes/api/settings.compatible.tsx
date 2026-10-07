import { agent } from "~/.server/agent";
import { makeCompatibleHandlers } from "~/.server/compatible-handlers";
const handlers = makeCompatibleHandlers(agent);

export const action = handlers.action;
export const loader = handlers.loader;
