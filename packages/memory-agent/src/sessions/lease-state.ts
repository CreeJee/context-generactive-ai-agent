/** Browser-safe shapes of session ownership. */

/** Header a page sends with every change it makes to a session (send, approve, cancel). */
export const sessionHolderHeader = "X-Session-Holder";

/** Who may change a session, as seen by one page (holder). */
export type LeaseView =
  /** This page owns the session. */
  | { readonly state: "mine" }
  /** Another page is using it; this one is read-only. */
  | { readonly state: "other"; readonly since: number }
  /** Nobody is using it: a read-only page may continue, after checking again. */
  | { readonly state: "free" };

export type ClaimResult =
  | { readonly claimed: true }
  | { readonly claimed: false; readonly heldSince: number };
