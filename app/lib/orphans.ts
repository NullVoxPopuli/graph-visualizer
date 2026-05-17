import type { LoadedGraph } from "./types.ts";

/**
 * Find every node that is *transitively orphaned* — nodes with no
 * incoming edges plus everything reachable downstream from them whose
 * only inbound paths come through other orphans. Concretely:
 *
 *   - Any node with `in-degree == 0` is an orphan.
 *   - A node becomes an orphan once all of its in-neighbors are
 *     orphans (because removing those in-neighbors drops its
 *     in-degree to zero too).
 *
 * Equivalent characterization: orphans are exactly the nodes whose
 * ancestor set in the directed graph contains no cycle. Anything that
 * sits on or downstream of a cycle is *not* an orphan — every node in
 * the cycle has an in-neighbor inside the cycle, which is itself not
 * an orphan, so the iteration never reaches them.
 *
 * Algorithm: Kahn's topological-sort peel against a working copy of
 * `inDegree`. O(N + E), linear in the graph size.
 *
 * Self-loops (`A → A`) leave the node with `in-degree ≥ 1` and an
 * in-neighbor (itself) that's never an orphan, so a self-looping
 * node is correctly excluded — matching the rest of the codebase's
 * "self-loops aren't cycles, but they aren't orphans either"
 * convention.
 *
 * `hiddenEdgeTypes` (optional) restricts the analysis to edges whose
 * `edgeTypeIds[i]` is *not* in the set — same way the renderer hides
 * filtered-out edge types. With a filter active we recompute in/out
 * adjacency over the visible edges; without one, the pre-cached
 * `graph.inDegree` is used directly.
 *
 * `rootIds` (optional, node indices) are nodes the user has declared
 * intentional roots: they're never peeled, so neither they nor the
 * subtree reachable only through them is reported as an orphan — even
 * when their in-degree is (or drops to) zero. A root with real
 * incoming edges is a no-op since it wouldn't have been peeled anyway.
 */
export function findOrphans(
  graph: LoadedGraph,
  hiddenEdgeTypes?: ReadonlySet<number>,
  rootIds?: ReadonlySet<number>,
): number[] {
  const N = graph.ids.length;

  if (N === 0) return [];

  const { edgesFlat, edgeTypeIds } = graph;
  const E = edgesFlat.length / 2;
  const filterTypes = hiddenEdgeTypes && hiddenEdgeTypes.size > 0 ? hiddenEdgeTypes : null;

  // Working copy of `inDegree`. With no edge-type filter we can clone
  // the pre-cached values; otherwise we recompute against the visible
  // edges only.
  let inDegree: Int32Array;

  if (filterTypes === null) {
    inDegree = new Int32Array(graph.inDegree);
  } else {
    inDegree = new Int32Array(N);

    for (let i = 0; i < E; i++) {
      if (filterTypes.has(edgeTypeIds[i]!)) continue;
      inDegree[edgesFlat[2 * i + 1]!]!++;
    }
  }

  // Outgoing CSR over the visible edges so each peeled node can reach
  // its successors quickly. Two-pass: count visible edges per source
  // for the prefix-sum, then place them.
  const outIdx = new Int32Array(N + 1);
  let visibleCount = 0;

  for (let i = 0; i < E; i++) {
    if (filterTypes !== null && filterTypes.has(edgeTypeIds[i]!)) continue;
    outIdx[edgesFlat[2 * i]! + 1]!++;
    visibleCount++;
  }

  for (let i = 0; i < N; i++) outIdx[i + 1]! += outIdx[i]!;

  const outAdj = new Int32Array(visibleCount);
  const filled = new Int32Array(N);

  for (let i = 0; i < E; i++) {
    if (filterTypes !== null && filterTypes.has(edgeTypeIds[i]!)) continue;

    const a = edgesFlat[2 * i]!;
    const b = edgesFlat[2 * i + 1]!;

    outAdj[outIdx[a]! + filled[a]!] = b;
    filled[a]!++;
  }

  const roots = rootIds && rootIds.size > 0 ? rootIds : null;
  const orphans: number[] = [];
  const queue: number[] = [];
  let head = 0;

  for (let i = 0; i < N; i++) {
    if (inDegree[i]! === 0 && !roots?.has(i)) queue.push(i);
  }

  while (head < queue.length) {
    const u = queue[head++]!;

    orphans.push(u);

    for (let j = outIdx[u]!; j < outIdx[u + 1]!; j++) {
      const v = outAdj[j]!;

      inDegree[v]!--;
      if (inDegree[v]! === 0 && !roots?.has(v)) queue.push(v);
    }
  }

  return orphans;
}

/**
 * Cheap "does the graph contain any orphan?" check. The first in-
 * degree-zero node (against visible edges) is enough.
 *
 * Fast path with no filter: reads the pre-cached `graph.inDegree`.
 * Slow path: scans `edgesFlat` once to mark every node with at least
 * one visible incoming edge, then any unmarked node is an orphan.
 */
export function hasAnyOrphan(graph: LoadedGraph, hiddenEdgeTypes?: ReadonlySet<number>): boolean {
  const N = graph.ids.length;

  if (N === 0) return false;

  if (!hiddenEdgeTypes || hiddenEdgeTypes.size === 0) {
    const inDegree = graph.inDegree;

    for (let i = 0; i < inDegree.length; i++) {
      if (inDegree[i] === 0) return true;
    }

    return false;
  }

  const { edgesFlat, edgeTypeIds } = graph;
  const E = edgesFlat.length / 2;
  const hasIncoming = new Uint8Array(N);

  for (let i = 0; i < E; i++) {
    if (hiddenEdgeTypes.has(edgeTypeIds[i]!)) continue;
    hasIncoming[edgesFlat[2 * i + 1]!] = 1;
  }

  for (let i = 0; i < N; i++) {
    if (hasIncoming[i] === 0) return true;
  }

  return false;
}
