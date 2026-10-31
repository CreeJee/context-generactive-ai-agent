/** Browser-safe shapes of session ownership. */

/** Header a page sends with every change it makes to a session (send, approve, cancel). */
export const sessionHolderHeader = "X-Session-Holder";

/** Who may change a session, as seen by one page (holder). */
export type { LeaseView } from "./contracts.ts";

export type ClaimResult =
  | { readonly claimed: true }
  | { readonly claimed: false; readonly heldSince: number };
