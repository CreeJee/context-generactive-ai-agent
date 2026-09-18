import { atomWithStorage } from "jotai/utils";

/** Unsent text by session, kept until it is sent or explicitly cleared. */
export const sessionDraftsAtom = atomWithStorage<Record<string, string>>(
  "context-agent-session-drafts",
  {},
);
