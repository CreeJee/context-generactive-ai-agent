import { agent } from "~/.server/agent";
import { makeBtwHandlers } from "~/.server/btw-handlers";
const handlers = makeBtwHandlers(agent);

export const loader = handlers.list;
export const action = handlers.create;
