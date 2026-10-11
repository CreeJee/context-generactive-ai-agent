import { agent } from "~/.server/agent";
import { makeReadRecoveryHandlers } from "~/.server/read-recovery-handlers";

export const action = makeReadRecoveryHandlers(agent).revokeAction;
