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
 * Cheap "does the graph contain any directed cycle?" answer. A 3-color
 * iterative DFS that returns as soon as it sees a back edge — so a
 * mostly-DAG resolves in roughly O(depth-to-first-cycle) rather than
 * the full O(N + E) that even an early-terminating `findAllCycles`
 * pays (it still builds CSR + runs Tarjan before short-circuiting).
 *
 * Self-loops are ignored to match `findAllCycles`'s semantics — that
 * function skips length-1 cycles, so a UI showing "There are no
 * cycles" alongside the full enumeration agrees with itself.
 */
export function hasAnyCycle(graph: LoadedGraph): boolean {
  const N = graph.ids.length;

  if (N === 0) return false;

  // Inline CSR build (mirrors `buildCsr` but skips the remap branch
  // we don't need here — this function only ever runs on the raw
  // graph). Kept here so the fast-path can't be slowed down by
  // refactoring the more-general helper.
  const { edgesFlat } = graph;
  const E = edgesFlat.length / 2;
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

  // 0 = unseen, 1 = on the current DFS stack, 2 = fully explored.
  const color = new Uint8Array(N);
  const stack = new Int32Array(N);
  const cursor = new Int32Array(N);

  for (let start = 0; start < N; start++) {
    if (color[start]! !== 0) continue;

    let depth = 0;

    stack[depth] = start;
    cursor[depth] = outIdx[start]!;
    color[start] = 1;

    while (depth >= 0) {
      const v = stack[depth]!;
      const end = outIdx[v + 1]!;

      if (cursor[depth]! >= end) {
        color[v] = 2;
        depth--;
        continue;
      }

      const j = cursor[depth]!;
      const w = outAdj[j]!;

      cursor[depth] = j + 1;

      // Self-loops aren't cycles in this codebase (see header note).
      if (w === v) continue;

      // The only edge into a node still on the DFS stack is a back
      // edge, which means a cycle.
      if (color[w]! === 1) return true;

      if (color[w]! === 0) {
        depth++;
        stack[depth] = w;
        cursor[depth] = outIdx[w]!;
        color[w] = 1;
      }
      // color[w] === 2: cross/forward edge into an already-finished
      // subtree, no new cycle reachable through w.
    }
  }

  return false;
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

  return bundleRawCycles(raw, nodeRemap);
}

/**
 * Contract every raw cycle through `nodeRemap`, dedupe by *visual key*,
 * and return shortest-first. Split out from `findBundledCyclesViaRaw`
 * so callers that need both the raw and bundled lists (the info panel)
 * can reuse a single `findAllCycles` pass instead of running the
 * exponential enumeration twice.
 *
 * The visual key collapses cycles that *look* identical when rendered
 * with the head/hidden/tail truncation into one entry — two cycles
 * that share the same canonical first node, canonical second node,
 * canonical last node, and total length are essentially "different
 * paths between the same two endpoints" from the user's perspective.
 * Showing them as separate rows produces dozens of visually identical
 * `application.ts → assistant.ts → … 54 hidden → auditable-entity.js`
 * entries that the user has explicitly said they don't want to see.
 * Short cycles (≤ 5 nodes) fall back to the full canonical sequence
 * since they render in full — collapsing those by endpoints would
 * over-merge unrelated 3-cycles like `a → b → c → a` and `a → d → c
 * → a`.
 */
export function bundleRawCycles(rawCycles: number[][], nodeRemap: Int32Array | null): number[][] {
  const seen = new Set<string>();
  const out: number[][] = [];

  for (const r of rawCycles) {
    const bundled = contractCycle(r, nodeRemap);

    if (bundled === null) continue;

    const key = visualCycleKey(bundled);

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(bundled);
  }

  out.sort((a, b) => a.length - b.length);

  return out;
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
 * Enumerate elementary directed cycles in the graph and return them
 * shortest-first. One entry per *cycle* rather than per SCC — a single
 * SCC can contain many overlapping cycles, and surfacing them all is the
 * whole point of the panel.
 *
 * Strategy: compute SCCs once, then for each non-trivial SCC run
 * Johnson's algorithm — for each node `s` (ascending), enumerate every
 * elementary cycle whose minimum vertex is `s`. The `w < start` filter
 * makes the "min-vertex-first" invariant hold so each cycle is emitted
 * exactly once across the outer pass. Critically, the inner DFS uses
 * Johnson's blocking (`blocked` + `B`) so that a node which fails to
 * reach `start` from one path is not re-explored when a sibling path
 * descends into it — without that, repeated work on dense SCCs is
 * what dominates the cost on large graphs.
 *
 * Worst case is still exponential in the SCC size — `maxCycles` is the
 * safety valve so a clique doesn't lock the worker forever. The output
 * is sorted by length so the UI's first entries are the smallest loops
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

    enumerateElementaryCyclesInScc(scc, N, outIdx, outAdj, inScc, cycles, maxCycles);
  }

  cycles.sort((a, b) => a.length - b.length);

  return cycles;
}

/**
 * Johnson's algorithm over a single SCC. For each `start` in the SCC
 * (ascending), CIRCUIT-walks the subgraph induced by `{ w | w >= start
 * and w in scc }` and emits every elementary cycle whose minimum vertex
 * is `start`.
 *
 * `blocked` + `B` are the work-saving piece: once a node `v` is fully
 * explored *without* completing a cycle back to `start`, it stays
 * blocked so that other paths reaching `v` don't re-explore its
 * subtree. `v` only gets unblocked when something that *can* close a
 * cycle reaches it — propagated transitively through `B`, where `B[w]`
 * holds nodes that gave up on traversing into `w`.
 *
 * The DFS is iterative (explicit `path` / `cursor` stacks) so deep
 * cycles don't blow the JS stack on large graphs. The unblock recursion
 * is also iterative for the same reason.
 */
function enumerateElementaryCyclesInScc(
  scc: number[],
  N: number,
  outIdx: Int32Array,
  outAdj: Int32Array,
  inScc: Uint8Array,
  out: number[][],
  maxCycles: number,
): void {
  const blocked = new Uint8Array(N);
  // `B[v]` is the set of nodes that are currently blocked *because* they
  // tried to reach `start` through `v` and failed. Stored as a singly-
  // linked list whose nodes live in two parallel growable Int32Arrays
  // (`bNode` + `bNext`) — avoids the per-edge `Set` allocations that
  // dominated the original `Set<number>[]` version on dense SCCs.
  const bHead = new Int32Array(N).fill(-1);
  let bNode = new Int32Array(64);
  let bNext = new Int32Array(64);
  let bAlloc = 0;
  const grow = (need: number): void => {
    if (need <= bNode.length) return;

    let cap = bNode.length;

    while (cap < need) cap *= 2;

    const nn = new Int32Array(cap);
    const nx = new Int32Array(cap);

    nn.set(bNode);
    nx.set(bNext);
    bNode = nn;
    bNext = nx;
  };

  const path: number[] = [];
  const cursor: number[] = [];
  // Per-frame flag: did the subtree rooted at `path[depth]` find a
  // cycle back to `start`? Drives the unblock-vs-extend-B decision when
  // the frame is popped. Sized to the SCC since `path.length` is bounded
  // by the SCC size (every entry is distinct and blocked).
  const foundAtDepth = new Uint8Array(scc.length);
  const unblockStack: number[] = [];

  const unblock = (u: number): void => {
    // Fast path: nothing waiting on `u`. By far the common case in
    // dense SCCs where almost every recursion finds a cycle and B[]
    // stays empty.
    if (bHead[u]! === -1) {
      blocked[u] = 0;

      return;
    }

    unblockStack.length = 0;
    unblockStack.push(u);

    while (unblockStack.length > 0) {
      const node = unblockStack.pop()!;

      if (blocked[node]! === 0) continue;
      blocked[node] = 0;

      let entry = bHead[node]!;

      bHead[node] = -1;

      while (entry !== -1) {
        const w = bNode[entry]!;
        const next = bNext[entry]!;

        if (blocked[w]! === 1) unblockStack.push(w);
        entry = next;
      }
    }
  };

  for (const start of scc) {
    if (out.length >= maxCycles) break;

    // Reset blocked/B for this start. Only touch SCC nodes — everything
    // else is already at its zero state from prior resets or initial
    // construction. We reuse the bNode/bNext buffers across starts by
    // resetting `bAlloc` to 0 and clearing only the heads we touched.
    for (const v of scc) {
      blocked[v] = 0;
      bHead[v] = -1;
    }

    bAlloc = 0;

    path.length = 0;
    cursor.length = 0;
    path.push(start);
    cursor.push(outIdx[start]!);
    foundAtDepth[0] = 0;
    blocked[start] = 1;

    while (path.length > 0) {
      if (out.length >= maxCycles) break;

      const depth = path.length - 1;
      const v = path[depth]!;
      const end = outIdx[v + 1]!;
      let recursed = false;

      while (cursor[depth]! < end) {
        const j = cursor[depth]!;
        const w = outAdj[j]!;

        cursor[depth] = j + 1;

        if (inScc[w] === 0) continue;
        // Smaller nodes' cycles will be (or were) enumerated at their
        // own pass — skip them here to avoid duplicates.
        if (w < start) continue;

        if (w === start) {
          out.push(path.slice());
          foundAtDepth[depth] = 1;
          if (out.length >= maxCycles) break;
          continue;
        }

        if (blocked[w]! === 0) {
          path.push(w);
          cursor.push(outIdx[w]!);
          foundAtDepth[path.length - 1] = 0;
          blocked[w] = 1;
          recursed = true;

          break;
        }
      }

      if (recursed) continue;

      const vFound = foundAtDepth[depth]! === 1;

      if (vFound) {
        unblock(v);
      } else {
        // No cycle through `v` this time. Record `v` as waiting on each
        // of its (currently blocked) out-neighbors so that if one of them
        // is later unblocked, `v` is too — that's the only signal that
        // `v` might newly be able to reach `start`. Duplicates are
        // allowed (cheaper than membership checks); `unblock` no-ops on
        // already-unblocked nodes so the extra entries are harmless.
        for (let j = outIdx[v]!; j < end; j++) {
          const w = outAdj[j]!;

          if (inScc[w] === 0) continue;
          if (w < start) continue;
          if (w === v) continue;

          grow(bAlloc + 1);
          bNode[bAlloc] = v;
          bNext[bAlloc] = bHead[w]!;
          bHead[w] = bAlloc;
          bAlloc++;
        }
      }

      path.pop();
      cursor.pop();

      if (vFound && path.length > 0) {
        foundAtDepth[path.length - 1] = 1;
      }
    }
  }
}
