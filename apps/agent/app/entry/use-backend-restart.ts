import { useSyncExternalStore } from "react";
import { backendRestartSnapshot, subscribeBackendRestart } from "./backend-restart";

/** React binding kept separate from the non-React store so this module has consistent exports. */
export const useBackendRestartRequired = () =>
  useSyncExternalStore(subscribeBackendRestart, backendRestartSnapshot, () => false);
