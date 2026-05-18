/**
 * Cheap cycle *presentation* helpers.
 *
 * The expensive elementary-cycle enumeration (Tarjan SCC + Johnson's,
 * exponential in the worst case) now runs once in the resident Rust
 * session — see `GraphSession.raw_cycles` / `VisualizerService.cycleRaw`.
 * This module is only the synchronous post-processing the panels apply
 * to that fixed raw-cycle list: contract through the collapsed-node
 * remap, dedupe by visual key, and assign stable short ids. None of it
 * touches the graph, so it stays in JS and runs instantly as the user
 * toggles collapse / selection.
 */

/**
 * Result of contraction that also remembers which raw nodes folded
 * into each bundled step. `bundled[i]` is the contracted rep at
 * position `i`; `groups[i]` lists the raw node indices that
 * contributed to it, in cycle-traversal order. Typically `groups[i]`
 * has a single entry — multiple entries appear when consecutive raw
 * nodes happened to share a rep (a chain of hidden files within the
 * same owning package) or when the wrap-around trim folded the
 * cycle's closing raw node back into the head step.
 *
 * The UI uses these groups to surface "package X · file foo.ts" rows
 * when the user has hidden the file type — same package can appear
 * twice in a contracted cycle because the underlying files are
 * different, and that detail is exactly what gets lost otherwise.
 */
export interface BundledWithGroups {
  bundled: number[];
  groups: number[][];
}

export function contractCycleWithGroups(
  raw: number[],
  nodeRemap: Int32Array | null,
): BundledWithGroups | null {
  if (nodeRemap === null) {
    return { bundled: raw.slice(), groups: raw.map((idx) => [idx]) };
  }

  const bundled: number[] = [];
  const groups: number[][] = [];

  for (const idx of raw) {
    const r = nodeRemap[idx]!;

    if (r < 0) return null;

    if (bundled.length > 0 && bundled[bundled.length - 1] === r) {
      groups[groups.length - 1]!.push(idx);
      continue;
    }

    bundled.push(r);
    groups.push([idx]);
  }

  // Wrap-around trim: collapse the duplicated closing rep. Merge the
  // popped tail's raw indices into the head's group so the closing-
  // edge file isn't silently dropped — it's the same package, but
  // *which* file matters for the user trying to read the cycle.
  while (bundled.length > 1 && bundled[0] === bundled[bundled.length - 1]) {
    bundled.pop();

    const tail = groups.pop()!;

    groups[0] = [...tail, ...groups[0]!];
  }

  if (bundled.length < 2) return null;

  return { bundled, groups };
}

/**
 * Rotate the cycle so the smallest node index is first, then stringify.
 * Two cycles that are rotations of each other (same nodes in the same
 * cyclic order) produce the same key — useful for deduping bundled
 * cycles that came from different raw cycles.
 */
export function canonicalCycleKey(cycle: number[]): string {
  let minIdx = 0;

  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i]! < cycle[minIdx]!) minIdx = i;
  }

  const out: number[] = [];

  for (let i = 0; i < cycle.length; i++) out.push(cycle[(minIdx + i) % cycle.length]!);

  return out.join(",");
}

/**
 * Dedup key that treats cycles which share the same canonical start +
 * second + last + length as the same cycle. For cycles of 5 nodes or
 * fewer the full canonical sequence is used (so we don't over-merge
 * short cycles where every node is visible). For longer cycles only
 * the visible "anchors" of the head/hidden/tail rendering matter,
 * because everything between them is hidden behind the
 * "N hidden — click to expand" marker anyway.
 */
function visualCycleKey(cycle: number[]): string {
  const n = cycle.length;

  if (n === 0) return "";

  let minIdx = 0;

  for (let i = 1; i < n; i++) {
    if (cycle[i]! < cycle[minIdx]!) minIdx = i;
  }

  if (n <= 5) {
    const out: number[] = [];

    for (let i = 0; i < n; i++) out.push(cycle[(minIdx + i) % n]!);

    return out.join(",");
  }

  const first = cycle[minIdx]!;
  const second = cycle[(minIdx + 1) % n]!;
  const last = cycle[(minIdx + n - 1) % n]!;

  return `${first}|${second}|${last}|${n}`;
}

/**
 * Contract every raw cycle through `nodeRemap`, dedupe by *visual key*,
 * and return shortest-first — each bundled cycle also carrying the
 * raw-node groups that collapsed into each step (so the panels can
 * show "package X · file foo.ts" per step when a node type is hidden).
 *
 * Operates on the fixed raw-cycle list the Rust session enumerated
 * once; this whole pass is O(total cycle length) and runs synchronously
 * on every collapse / selection toggle.
 */
export function bundleRawCyclesWithGroups(
  rawCycles: number[][],
  nodeRemap: Int32Array | null,
): BundledWithGroups[] {
  const seen = new Set<string>();
  const out: BundledWithGroups[] = [];

  for (const r of rawCycles) {
    const contracted = contractCycleWithGroups(r, nodeRemap);

    if (contracted === null) continue;

    const key = visualCycleKey(contracted.bundled);

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(contracted);
  }

  out.sort((a, b) => a.bundled.length - b.bundled.length);

  return out;
}

/**
 * Short, UUID-first-segment-style identifier for a cycle. Derived
 * deterministically from the cycle's canonical key via FNV-1a 32-bit
 * hashing and rendered as 8 lower-case hex chars — same canonical key
 * always maps to the same id, so a cycle's id is stable across
 * reloads and shared URLs.
 *
 * If the generated id collides with one already in `used`, the key is
 * re-hashed with an attempt-number suffix until a free slot is found.
 * Birthday math on 8 hex chars vs. ~1000 cycles makes the conflict
 * branch almost never run in practice; it's there so we can promise
 * "unique within the current cycle list."
 */
export function shortCycleId(canonicalKey: string, used: Set<string>): string {
  let id = fnv1aHex(canonicalKey);
  let attempt = 0;

  while (used.has(id)) {
    attempt++;
    id = fnv1aHex(`${canonicalKey}:${attempt}`);
    if (attempt > 100) break;
  }

  used.add(id);

  return id;
}

function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;

  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }

  return (h >>> 0).toString(16).padStart(8, "0");
}
