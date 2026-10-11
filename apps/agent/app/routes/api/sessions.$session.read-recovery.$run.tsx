import { agent } from "~/.server/agent";
import { makeReadRecoveryHandlers } from "~/.server/read-recovery-handlers";

/** GET previews; POST requires the preview token and explicit no-replay/backup confirmation. */
const handlers = makeReadRecoveryHandlers(agent);
export const loader = handlers.loader;
export const action = handlers.action;
