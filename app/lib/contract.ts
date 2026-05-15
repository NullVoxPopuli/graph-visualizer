import type { LoadedGraph } from "./types.ts";

/**
 * Result of applying the node-type filter and the per-node `col` toggles
 * to a graph. Consumers (renderer, picker, cycle detection) all read from
 * the same struct so what's drawn matches what gets clicked and what gets
 * traversed.
 */
export interface Contraction {
  /** 1 = node is hidden in the contracted view. */
  hideMask: Uint8Array;
  /**
   * Per-node rep: visible nodes map to themselves, hidden nodes to their
   * nearest visible predecessor (chains of hidden nodes propagate), or
   * `-1` when no visible owner is reachable.
   */
  nodeRemap: Int32Array;
  /**
   * Adjusted display radius. Visible nodes absorb the area of the hidden
   * nodes they own; total ink is conserved.
   */
  effectiveRadii: Float32Array;
}

/**
 * Build the contraction for the current type filter + per-node toggles.
 * Returns `null` when nothing is hidden (caller falls back to the raw
 * scene radii and no remap).
 *
 * `hiddenNodeIds` are individual nodes the user explicitly hid; they
 * differ from `hiddenTypes` in that they never get folded into a visible
 * owner — their `nodeRemap` entry stays `-1` so any edge touching them
 * is dropped entirely (consistent with "hidden from the graph and cycle
 * detection").
 */
export function buildContraction(
  graph: LoadedGraph,
  radii: Float32Array,
  hiddenTypes: Set<number>,
  collapsedIds: Set<string>,
  hiddenNodeIds: Set<string> = new Set(),
): Contraction | null {
  if (hiddenTypes.size === 0 && collapsedIds.size === 0 && hiddenNodeIds.size === 0) return null;

  const { nodeTypeIds, edgesFlat, idToIndex } = graph;
  const N = nodeTypeIds.length;

  const typeHidden = new Uint8Array(N);

  for (let i = 0; i < N; i++) {
    if (hiddenTypes.has(nodeTypeIds[i]!)) typeHidden[i] = 1;
  }

  // Per-id user hides — hard-drop, no owner folding.
  const idHidden = new Uint8Array(N);

  for (const id of hiddenNodeIds) {
    const idx = idToIndex.get(id);

    if (idx !== undefined) idHidden[idx] = 1;
  }

  // Direct outgoing targets of any node listed in `col` get their
  // baseline flipped — collapse when they'd be visible, expand when the
  // type filter would have hidden them.
  const invertTarget = new Uint8Array(N);

  if (collapsedIds.size > 0) {
    const collapsedIdxSet = new Uint8Array(N);

    for (const id of collapsedIds) {
      const idx = idToIndex.get(id);

      if (idx !== undefined) collapsedIdxSet[idx] = 1;
    }

    for (let i = 0; i < edgesFlat.length; i += 2) {
      if (collapsedIdxSet[edgesFlat[i]!] === 1) invertTarget[edgesFlat[i + 1]!] = 1;
    }
  }

  const mask = new Uint8Array(N);

  for (let i = 0; i < N; i++) {
    // Hard-hidden wins over any expand/collapse interplay.
    if (idHidden[i] === 1) mask[i] = 1;
    else mask[i] = typeHidden[i]! ^ invertTarget[i]!;
  }

  // Assign each hidden node an "owner" — its nearest visible predecessor.
  // ID-hidden nodes deliberately skip this so their edges are dropped
  // instead of folded onto a neighbor.
  const owner = new Int32Array(N).fill(-1);

  for (let i = 0; i < edgesFlat.length; i += 2) {
    const a = edgesFlat[i]!;
    const b = edgesFlat[i + 1]!;

    if (idHidden[b] === 1 || idHidden[a] === 1) continue;
    if (mask[b] === 1 && mask[a] === 0 && owner[b]! === -1) owner[b] = a;
  }

  let changed = true;
  let passes = 0;

  while (changed && passes < N) {
    changed = false;
    passes++;

    for (let i = 0; i < edgesFlat.length; i += 2) {
      const a = edgesFlat[i]!;
      const b = edgesFlat[i + 1]!;

      if (idHidden[a] === 1 || idHidden[b] === 1) continue;

      if (mask[b] === 1 && mask[a] === 1 && owner[a]! !== -1 && owner[b]! === -1) {
        owner[b] = owner[a]!;
        changed = true;
      }
    }
  }

  const remap = new Int32Array(N);

  for (let i = 0; i < N; i++) remap[i] = mask[i] === 0 ? i : owner[i]!;

  const absorbedArea = new Float32Array(N);

  for (let i = 0; i < N; i++) {
    if (mask[i] === 1 && owner[i]! >= 0) {
      absorbedArea[owner[i]!]! += radii[i]! * radii[i]!;
    }
  }

  const eff = new Float32Array(N);

  for (let i = 0; i < N; i++) {
    if (mask[i] === 1) {
      eff[i] = 0;
    } else {
      const own = radii[i]!;
      const absorbed = absorbedArea[i]!;

      eff[i] = absorbed > 0 ? Math.sqrt(own * own + absorbed) : own;
    }
  }

  return { hideMask: mask, nodeRemap: remap, effectiveRadii: eff };
}
