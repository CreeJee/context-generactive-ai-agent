import type { AppChangedEvent } from "./contracts";
import { invalidationKeys } from "./query-keys";

export type QueryKey = readonly unknown[];

/** Coalesces burst events by query key and makes ready repair snapshot/open races. */
export function createInvalidationBatch(
  invalidate: (key: QueryKey) => void,
  root: QueryKey,
  delayMs: number = 50,
) {
  const revisions = new Map<string, number>();
  const pending = new Map<string, QueryKey>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    const keys = [...pending.values()];
    pending.clear();
    for (const key of keys) invalidate(key);
  };

  return {
    ready() {
      invalidate(root);
    },
    changed(event: AppChangedEvent) {
      const revisionKey = `${event.scope}:${event.topic}`;
      if ((revisions.get(revisionKey) ?? -1) >= event.revision) return;
      revisions.set(revisionKey, event.revision);
      for (const key of invalidationKeys(event)) pending.set(JSON.stringify(key), key);
      if (timer === null) timer = setTimeout(flush, delayMs);
    },
    close() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}
