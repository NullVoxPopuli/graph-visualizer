/**
 * Result of collapsing a long list to `head … N hidden … tail` for UI
 * display. `head` holds the first couple of items and `tail` holds the
 * last; `hiddenCount` is the number of items elided between them. When
 * the list is short (≤5) or the caller passed `expanded: true`, `head`
 * holds everything and `hiddenCount` / `tail` are empty — templates can
 * render the same `head → hidden marker → tail` structure unconditionally
 * and let the helper decide whether the marker actually appears.
 */
export interface Collapsed<T> {
  head: T[];
  /** When > 0, render a "… N hidden …" marker between head and tail. */
  hiddenCount: number;
  tail: T[];
}

/**
 * Collapse `items` to `head + hidden marker + tail`. When `expanded` is
 * true we bypass the collapse and put everything in `head` — the user
 * clicked the marker to see the full list. Lists of 5 or fewer rows are
 * never collapsed (the marker would save at most one row and just hide
 * context).
 */
export function collapseList<T>(items: T[], expanded: boolean): Collapsed<T> {
  if (expanded || items.length <= 5) {
    return { head: items, hiddenCount: 0, tail: [] };
  }

  const last = items.length - 1;

  return {
    head: [items[0]!, items[1]!],
    hiddenCount: items.length - 3,
    tail: [items[last]!],
  };
}

/**
 * Toggle membership of `key` in `set`, returning a fresh `Set` so a
 * `@tracked` slot the set is assigned to detects the change. The input
 * set is left untouched.
 */
export function toggleInSet(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);

  if (next.has(key)) next.delete(key);
  else next.add(key);

  return next;
}
