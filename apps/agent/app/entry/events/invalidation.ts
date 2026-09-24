import type { AppChangedEvent } from "./contracts";
import { invalidationKeys } from "./query-keys";

export type QueryKey = readonly unknown[];

/** SSE changes invalidate their query immediately; ready repairs missed events. */
export function createEventInvalidator(invalidate: (key: QueryKey) => void, root: QueryKey) {
  let revision: number | null = null;

  return {
    ready(nextRevision: number) {
      // The first ready closes the initial query/subscription gap. Later ready events
      // only need repair if the stream missed a revision while disconnected.
      if (revision === null || revision !== nextRevision) invalidate(root);
      revision = nextRevision;
    },
    changed(event: AppChangedEvent) {
      if (revision !== null && event.revision <= revision) return;
      revision = event.revision;
      for (const key of invalidationKeys(event)) invalidate(key);
    },
  };
}
