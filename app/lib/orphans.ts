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
 */
export function findOrphans(graph: LoadedGraph): number[] {
  const N = graph.ids.length;

  if (N === 0) return [];

  // Working copy — we decrement as we peel each orphan off the
  // graph. The cached `graph.inDegree` is read-only.
  const inDegree = new Int32Array(graph.inDegree);

  const { edgesFlat } = graph;
  const E = edgesFlat.length / 2;
  // Outgoing CSR so each peeled node can reach its successors quickly.
  const outIdx = new Int32Array(N + 1);

  for (let i = 0; i < E; i++) outIdx[edgesFlat[2 * i]! + 1]!++;
  for (let i = 0; i < N; i++) outIdx[i + 1]! += outIdx[i]!;

  const outAdj = new Int32Array(E);
  const filled = new Int32Array(N);

  for (let i = 0; i < E; i++) {
    const a = edgesFlat[2 * i]!;
    const b = edgesFlat[2 * i + 1]!;

    outAdj[outIdx[a]! + filled[a]!] = b;
    filled[a]!++;
  }

  const orphans: number[] = [];
  const queue: number[] = [];
  let head = 0;

  for (let i = 0; i < N; i++) {
    if (inDegree[i]! === 0) queue.push(i);
  }

  while (head < queue.length) {
    const u = queue[head++]!;

    orphans.push(u);

    for (let j = outIdx[u]!; j < outIdx[u + 1]!; j++) {
      const v = outAdj[j]!;

      inDegree[v]!--;
      if (inDegree[v]! === 0) queue.push(v);
    }
  }

  return orphans;
}

/**
 * Cheap "does the graph contain any orphan?" check. The first in-
 * degree-zero node is enough — anything with no incoming edges is
 * automatically an orphan, so the more involved transitive computation
 * in `findOrphans` is never needed just to answer this yes/no.
 */
export function hasAnyOrphan(graph: LoadedGraph): boolean {
  const inDegree = graph.inDegree;

  for (let i = 0; i < inDegree.length; i++) {
    if (inDegree[i] === 0) return true;
  }

  return false;
}
