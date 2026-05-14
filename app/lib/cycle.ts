import type { LoadedGraph } from "./types.ts";

/**
 * Find the shortest directed cycle passing through `source` and return the
 * cycle's nodes in order, starting at `source` (the closing edge back to
 * `source` is implied — `source` is not duplicated at the end). `null` if
 * no cycle exists.
 *
 * When `nodeRemap` is provided, traversal runs on the *contracted* graph:
 * each edge endpoint is replaced with `nodeRemap[i]`, hidden endpoints
 * (`-1`) and self-loops after contraction are dropped, and `source` itself
 * must be a visible rep (`nodeRemap[source] === source`). This keeps the
 * cycle in sync with what the renderer draws when nodes are hidden /
 * collapsed.
 *
 * Implementation: BFS from `source` over outgoing edges; the first time an
 * out-neighbor equals `source` we've found the shortest such cycle, and
 * we walk the parent chain back to recover the path. A CSR-style flat
 * adjacency is built up front so the inner BFS loop is allocation-free.
 */
export function findShortestCycleThrough(
  graph: LoadedGraph,
  source: number,
  nodeRemap: Int32Array | null = null,
): number[] | null {
  const { edgesFlat } = graph;
  const N = graph.ids.length;

  if (N === 0 || source < 0 || source >= N) return null;
  if (nodeRemap !== null && nodeRemap[source]! !== source) return null;

  const E = edgesFlat.length / 2;

  // Two-pass CSR build with edge remapping. First pass counts out-degree
  // after contraction so we can size the flat adjacency; second pass fills
  // it. Duplicates after contraction (many file→file edges collapsing into
  // the same package→package) are allowed — BFS visits each target node
  // once via `seen`, so duplicates are wasted iterations but not wrong.
  const outIdx = new Int32Array(N + 1);
  const remappedA = new Int32Array(E);
  const remappedB = new Int32Array(E);
  let M = 0;

  for (let i = 0; i < E; i++) {
    let a = edgesFlat[2 * i]!;
    let b = edgesFlat[2 * i + 1]!;

    if (nodeRemap !== null) {
      a = nodeRemap[a]!;
      b = nodeRemap[b]!;
      if (a < 0 || b < 0) continue;
      if (a === b) continue;
    }

    remappedA[M] = a;
    remappedB[M] = b;
    M++;
    outIdx[a + 1]!++;
  }

  for (let i = 0; i < N; i++) outIdx[i + 1]! += outIdx[i]!;

  const outAdj = new Int32Array(M);
  const filled = new Int32Array(N);

  for (let i = 0; i < M; i++) {
    const a = remappedA[i]!;

    outAdj[outIdx[a]! + filled[a]!] = remappedB[i]!;
    filled[a]!++;
  }

  const parent = new Int32Array(N).fill(-1);
  const seen = new Uint8Array(N);

  seen[source] = 1;

  const queue: number[] = [source];
  let head = 0;

  while (head < queue.length) {
    const u = queue[head++]!;

    for (let j = outIdx[u]!; j < outIdx[u + 1]!; j++) {
      const w = outAdj[j]!;

      if (w === source) {
        const path: number[] = [];
        let cur = u;

        while (cur !== source) {
          path.push(cur);
          cur = parent[cur]!;
        }

        path.reverse();

        return [source, ...path];
      }

      if (!seen[w]) {
        seen[w] = 1;
        parent[w] = u;
        queue.push(w);
      }
    }
  }

  return null;
}
