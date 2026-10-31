import { useSyncExternalStore } from "react";

const unchanging = () => () => {};

/**
 * False while React hydrates the server's HTML, true after it and on every render that starts in
 * the browser. Text that depends on the browser, such as its time zone, waits for it, so the page
 * hydrates the same markup the server rendered.
 */
export const useHydrated = () =>
  useSyncExternalStore(
    unchanging,
    () => true,
    () => false,
  );
