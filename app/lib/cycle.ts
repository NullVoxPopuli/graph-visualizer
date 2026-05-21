import type { LoadedGraph } from "./types.ts";

/**
 * Cheap cycle *presentation* helpers.
 *
 * The cycle enumeration itself runs once in the resident Rust session
 * — see `GraphSession.shortest_cycles` / `VisualizerService.cycleShortest`
 * (Tarjan SCC + BFS-per-node, polynomial). This module is only the
 * synchronous post-processing the panels apply to that fixed cycle
 * list: contract through the collapsed-node remap, dedupe by visual
 * key, and assign stable short ids. None of it touches the graph, so
 * it stays in JS and runs instantly as the user toggles collapse /
 * selection.
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
export function visualCycleKey(cycle: number[]): string {
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

/**
 * When Rust enumerates cycles on the *contracted* CSR (i.e., a non-null
 * `nodeRemap` was passed to `shortest_cycles`), each returned cycle is
 * already a sequence of visible reps — none of the hidden files that
 * actually formed the underlying graph cycle survive. The cycles-panel
 * still wants to show those files under each bundled step (so the user
 * can see *which* files in package A reach into package B), so we
 * reconstruct one representative file chain per step here.
 *
 * For each consecutive pair `(a, b)` we BFS from `a` through nodes
 * still in `a`'s territory (`nodeRemap[u] === a`), stopping as soon as
 * we reach a node `v` mapped to `b` (`nodeRemap[v] === b`). The
 * intermediate hidden nodes are the chain; we prepend `a` itself so
 * the output matches the shape `bundleRawCyclesWithGroups` produced
 * before — `groups[i] = [visibleRep, ...hiddenFilesInItsTerritory]`,
 * and the panel filters the visible rep out at render time. Steps
 * where the contracted edge came from a direct `a -> b` graph edge
 * yield `groups[i] = [a]`, which the panel already handles as
 * "no file chips for this step".
 *
 * Returns `null` when any step has no chain at all (e.g., the
 * contracted edge `(a, b)` has no underlying graph path that stays
 * inside `a`'s package — possible if the remap pulled in an exotic
 * collapse/expand combination). The caller then falls back to bare
 * visible reps with no file chips, instead of dropping the whole
 * cycle.
 */
/**
 * Pair counterpart to `bundleRawCyclesWithGroups` for the path where
 * Rust enumerated on the *contracted* CSR — i.e. each input cycle is
 * already a sequence of visible reps. Dedupe by the same visual key
 * the legacy path used (so a fan-out of head/tail-identical cycles in
 * the contracted graph collapses to one row instead of swamping the
 * panel), sort shortest-first, then reconstruct the file chain under
 * each step via BFS so the per-step file chips can still render.
 *
 * Falls back to single-element groups when the BFS can't find a
 * connected chain — the row still surfaces, just without raw-file
 * chips for that step, which beats silently dropping a real cycle.
 */
export function bundleAlreadyContractedCycles(
  graph: LoadedGraph,
  nodeRemap: Int32Array,
  contractedCycles: number[][],
): BundledWithGroups[] {
  const seen = new Set<string>();
  const out: BundledWithGroups[] = [];

  for (const c of contractedCycles) {
    const key = visualCycleKey(c);

    if (seen.has(key)) continue;
    seen.add(key);

    const groups = reconstructGroupsForBundledCycle(graph, nodeRemap, c);

    out.push({ bundled: c, groups: groups ?? c.map((idx) => [idx]) });
  }

  out.sort((a, b) => a.bundled.length - b.bundled.length);

  return out;
}

export function reconstructGroupsForBundledCycle(
  graph: LoadedGraph,
  nodeRemap: Int32Array,
  bundled: number[],
): number[][] | null {
  const { edgesFlat } = graph;
  const N = nodeRemap.length;
  const E = edgesFlat.length / 2;
  // Rebuild outgoing CSR per call; it's O(E) once, then every BFS is
  // O(packageSize) which dominates the unique work. The graph's other
  // consumers don't need a CSR, so we don't cache it on the graph.
  const outIdx = new Int32Array(N + 1);

  for (let i = 0; i < E; i++) outIdx[edgesFlat[2 * i]! + 1]!++;
  for (let i = 0; i < N; i++) outIdx[i + 1]! += outIdx[i]!;

  const outAdj = new Int32Array(E);
  const cursor = new Int32Array(N);

  for (let i = 0; i < E; i++) {
    const a = edgesFlat[2 * i]!;
    const b = edgesFlat[2 * i + 1]!;

    outAdj[outIdx[a]! + cursor[a]!] = b;
    cursor[a]!++;
  }

  const groups: number[][] = [];

  // Scratch arrays reused across steps — every BFS only touches at most
  // the source package's territory, so a per-step reset of `visited`
  // and `parent` along the queue is cheaper than re-allocating.
  const visited = new Uint8Array(N);
  const parent = new Int32Array(N);

  for (let i = 0; i < bundled.length; i++) {
    const startRep = bundled[i]!;
    const endRep = bundled[(i + 1) % bundled.length]!;

    visited.fill(0);
    parent.fill(-1);
    visited[startRep] = 1;

    const queue: number[] = [startRep];
    let found = -1;

    bfs: while (queue.length > 0) {
      const u = queue.shift()!;
      const from = outIdx[u]!;
      const to = outIdx[u + 1]!;

      for (let j = from; j < to; j++) {
        const v = outAdj[j]!;

        if (visited[v]) continue;

        if (nodeRemap[v] === endRep) {
          parent[v] = u;
          found = v;

          break bfs;
        }

        if (nodeRemap[v] === startRep) {
          visited[v] = 1;
          parent[v] = u;
          queue.push(v);
        }
      }
    }

    if (found === -1) return null;

    // Walk parents from the node just *before* `found` (which sits in
    // `endRep`'s territory and will be the head of the next step's
    // group anyway) back to `startRep`. That gives the hidden chain in
    // `startRep`'s territory between the two visible reps.
    const chain: number[] = [];
    let cur = parent[found]!;

    while (cur !== -1 && cur !== startRep) {
      chain.push(cur);
      cur = parent[cur]!;
    }

    chain.reverse();
    groups.push([startRep, ...chain]);
  }

  return groups;
}
