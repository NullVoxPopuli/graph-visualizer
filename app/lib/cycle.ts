import type { LoadedGraph } from "./types.ts";

/**
 * Map a raw cycle (node sequence over the original graph) to its
 * contracted equivalent. Collapses consecutive same-rep nodes (a chain
 * of hidden nodes that all map to the same owner becomes one stop) and
 * trims the wrap-around duplicate at the end. Returns `null` for
 * pathological cases — an orphan-after-remap node (`-1`) or a cycle
 * that contracts to a 0/1-node walk.
 */
export function contractCycle(raw: number[], nodeRemap: Int32Array | null): number[] | null {
  if (nodeRemap === null) {
    return raw.slice();
  }

  const out: number[] = [];

  for (const idx of raw) {
    const r = nodeRemap[idx]!;

    if (r < 0) return null;
    if (out.length > 0 && out[out.length - 1] === r) continue;
    out.push(r);
  }

  while (out.length > 1 && out[0] === out[out.length - 1]) out.pop();

  return out.length >= 2 ? out : null;
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
 * CSR (compressed sparse row) outgoing adjacency built once for both
 * cycle detection passes. Endpoints are remapped through `nodeRemap` when
 * provided so traversal matches the rendered (contracted) graph.
 */
interface CsrOut {
  outIdx: Int32Array;
  outAdj: Int32Array;
}

function buildCsr(graph: LoadedGraph, nodeRemap: Int32Array | null): CsrOut {
  const { edgesFlat } = graph;
  const N = graph.ids.length;
  const E = edgesFlat.length / 2;
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

  return { outIdx, outAdj };
}

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
  const N = graph.ids.length;

  if (N === 0 || source < 0 || source >= N) return null;
  if (nodeRemap !== null && nodeRemap[source]! !== source) return null;

  const { outIdx, outAdj } = buildCsr(graph, nodeRemap);

  return shortestCycleFromSource(source, N, outIdx, outAdj, null);
}

/**
 * BFS from `source` over the CSR adjacency. Optional `restrictTo` mask
 * confines traversal to a specific node set (used for finding a cycle
 * within a single SCC); when null, the whole graph is walkable.
 */
function shortestCycleFromSource(
  source: number,
  N: number,
  outIdx: Int32Array,
  outAdj: Int32Array,
  restrictTo: Uint8Array | null,
): number[] | null {
  const parent = new Int32Array(N).fill(-1);
  const seen = new Uint8Array(N);

  seen[source] = 1;

  const queue: number[] = [source];
  let head = 0;

  while (head < queue.length) {
    const u = queue[head++]!;

    for (let j = outIdx[u]!; j < outIdx[u + 1]!; j++) {
      const w = outAdj[j]!;

      if (restrictTo !== null && restrictTo[w] === 0) continue;

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

/**
 * Compute the non-trivial strongly connected components of the CSR graph.
 * Uses iterative Tarjan so deep DFS chains don't blow the JS stack on
 * thousand-node graphs.
 *
 * `excludeNode` (when ≥ 0) is treated as if it has no outgoing edges —
 * used by `findAllCycles` to "remove" a node once Johnson-style cycle
 * enumeration has finished with it. `nodeRemap` (optional) skips orphan
 * nodes left over from contraction.
 */
function tarjanScc(
  N: number,
  outIdx: Int32Array,
  outAdj: Int32Array,
  excludeNode: number,
  nodeRemap: Int32Array | null,
): number[][] {
  const indexOf = new Int32Array(N).fill(-1);
  const lowlink = new Int32Array(N);
  const onStack = new Uint8Array(N);
  const stack: number[] = [];
  const callNode = new Int32Array(N);
  const callCursor = new Int32Array(N);
  let depth = 0;
  let idxCounter = 0;
  const sccs: number[][] = [];

  for (let start = 0; start < N; start++) {
    if (indexOf[start]! !== -1) continue;
    if (start < excludeNode) continue;
    if (nodeRemap !== null && nodeRemap[start]! !== start) continue;

    callNode[depth] = start;
    callCursor[depth] = outIdx[start]!;
    depth++;
    indexOf[start] = idxCounter;
    lowlink[start] = idxCounter;
    idxCounter++;
    stack.push(start);
    onStack[start] = 1;

    while (depth > 0) {
      const v = callNode[depth - 1]!;
      const end = outIdx[v + 1]!;
      let recursed = false;

      while (callCursor[depth - 1]! < end) {
        const j = callCursor[depth - 1]!;
        const w = outAdj[j]!;

        callCursor[depth - 1] = j + 1;
        // Restrict to the "alive" sub-graph: ignore deleted (w < excludeNode)
        // and orphan-after-remap edges.
        if (w < excludeNode) continue;
        if (nodeRemap !== null && nodeRemap[w]! !== w) continue;

        if (indexOf[w]! === -1) {
          callNode[depth] = w;
          callCursor[depth] = outIdx[w]!;
          depth++;
          indexOf[w] = idxCounter;
          lowlink[w] = idxCounter;
          idxCounter++;
          stack.push(w);
          onStack[w] = 1;
          recursed = true;

          break;
        } else if (onStack[w] === 1 && indexOf[w]! < lowlink[v]!) {
          lowlink[v] = indexOf[w]!;
        }
      }

      if (recursed) continue;

      if (lowlink[v]! === indexOf[v]!) {
        const scc: number[] = [];
        let popped: number;

        do {
          popped = stack.pop()!;
          onStack[popped] = 0;
          scc.push(popped);
        } while (popped !== v);

        if (scc.length > 1) sccs.push(scc);
      }

      depth--;

      if (depth > 0) {
        const parent = callNode[depth - 1]!;

        if (lowlink[v]! < lowlink[parent]!) lowlink[parent] = lowlink[v]!;
      }
    }
  }

  return sccs;
}

/**
 * Find the bundled cycles that are *backed by an actual raw elementary
 * cycle*. The contracted graph (`findAllCycles(g, remap)`) can have
 * structural cycles that don't correspond to any closed walk in the raw
 * graph — two unrelated raw edges crossing the same package pair will
 * fold into a contracted `P → Q → P` even though no single raw cycle
 * exists. Drawing those as red cycle highlights misleads the user, so we
 * derive the bundled list from the raw cycles instead: contract each raw
 * cycle, dedupe by canonical key.
 *
 * `null` remap returns the raw cycles unchanged.
 */
export function findBundledCyclesViaRaw(
  graph: LoadedGraph,
  nodeRemap: Int32Array | null,
  maxCycles = 1000,
): number[][] {
  const raw = findAllCycles(graph, null, maxCycles);
  const seen = new Set<string>();
  const out: number[][] = [];

  for (const r of raw) {
    const bundled = contractCycle(r, nodeRemap);

    if (bundled === null) continue;

    const key = canonicalCycleKey(bundled);

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(bundled);
  }

  out.sort((a, b) => a.length - b.length);

  return out;
}

/**
 * Enumerate elementary directed cycles in the graph and return them
 * shortest-first. One entry per *cycle* rather than per SCC — a single
 * SCC can contain many overlapping cycles, and surfacing them all is the
 * whole point of the panel.
 *
 * Strategy: compute SCCs once, then for each non-trivial SCC walk each
 * node `s` in ascending order and emit every elementary cycle whose
 * minimum vertex is `s`. The `w < start` filter inside
 * `enumerateElementaryCycles` is what makes the "min-vertex-first"
 * invariant hold, so each cycle is emitted exactly once across the
 * outer pass.
 *
 * Worst case is exponential in the SCC size — `maxCycles` is the safety
 * valve so a clique doesn't lock the worker forever. The output is
 * sorted by length so the UI's first entries are the smallest loops
 * (usually the most actionable).
 */
export function findAllCycles(
  graph: LoadedGraph,
  nodeRemap: Int32Array | null = null,
  maxCycles = 1000,
): number[][] {
  const N = graph.ids.length;

  if (N === 0) return [];

  const { outIdx, outAdj } = buildCsr(graph, nodeRemap);
  const sccs = tarjanScc(N, outIdx, outAdj, 0, nodeRemap);
  const cycles: number[][] = [];

  for (const scc of sccs) {
    if (scc.length < 2) continue;
    if (cycles.length >= maxCycles) break;

    scc.sort((a, b) => a - b);

    const inScc = new Uint8Array(N);

    for (const v of scc) inScc[v] = 1;

    for (const start of scc) {
      if (cycles.length >= maxCycles) break;
      enumerateElementaryCycles(start, N, outIdx, outAdj, inScc, cycles, maxCycles);
    }
  }

  cycles.sort((a, b) => a.length - b.length);

  return cycles;
}

/**
 * Iterative DFS from `start` that emits every elementary cycle whose
 * minimum node is `start`. The restriction to `inScc` keeps the DFS
 * inside one SCC, and the `start`-is-the-minimum invariant (enforced by
 * `w >= start` filtering) makes sure each cycle is emitted exactly once
 * across the outer Johnson loop. Reuses a per-call `onPath` mask plus a
 * single `path` array as the open scratch space.
 */
function enumerateElementaryCycles(
  start: number,
  N: number,
  outIdx: Int32Array,
  outAdj: Int32Array,
  inScc: Uint8Array,
  out: number[][],
  maxCycles: number,
): void {
  const onPath = new Uint8Array(N);
  const path: number[] = [start];
  const cursor: number[] = [outIdx[start]!];

  onPath[start] = 1;

  while (path.length > 0 && out.length < maxCycles) {
    const depth = path.length - 1;
    const v = path[depth]!;
    const end = outIdx[v + 1]!;

    if (cursor[depth]! >= end) {
      onPath[v] = 0;
      path.pop();
      cursor.pop();
      continue;
    }

    const j = cursor[depth]!;
    const w = outAdj[j]!;

    cursor[depth] = j + 1;

    if (inScc[w] === 0) continue;
    // Smaller nodes' cycles will be (or were) enumerated at their own
    // pass — skip them here to avoid duplicates.
    if (w < start) continue;

    if (w === start) {
      out.push(path.slice());
      continue;
    }

    if (onPath[w] === 1) continue;

    onPath[w] = 1;
    path.push(w);
    cursor.push(outIdx[w]!);
  }
}
