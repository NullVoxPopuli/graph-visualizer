/**
 * Deterministic synthetic graph generator for layout benchmarks.
 *
 * Produces a `LayoutInit` shaped like what `#services/visualizer` feeds the
 * layout worker in production: a clustered random graph (mostly
 * intra-community edges, a sprinkle of inter-community ones) with degree-
 * derived radii. Seeded so every run — and the JS-vs-WASM comparison —
 * sees the exact same graph.
 *
 * This is intentionally a separate, dependency-free module: the benchmark
 * harness imports it, but so could a future fuzz/property test.
 */
import type { LayoutInit } from "../app/lib/layout-types.ts";

/** mulberry32 — tiny, fast, good-enough seeded PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;

  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;

    let t = Math.imul(a ^ (a >>> 15), 1 | a);

    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GraphGenOptions {
  nodeCount: number;
  /** Number of communities. Defaults to ~`sqrt(nodeCount)`, like a real
   *  Louvain partition tends to land. */
  communityCount?: number;
  /** Mean out-edges per node that stay inside the community. */
  intraDegree?: number;
  /** Probability an extra edge crosses to another community. */
  interEdgeProb?: number;
  seed?: number;
}

/**
 * The d3-force slider defaults from `#services/view-state`
 * (repulsion 6, nodeDistance 18, clusterDistance 180) plus the fixed
 * `cohesion: 0.12` / `spreadFactor: 1` the visualizer always sends.
 */
export const DEFAULT_LAYOUT_PARAMS = {
  spreadFactor: 1,
  repulsion: 6,
  nodeDistance: 18,
  clusterDistance: 180,
  cohesion: 0.12,
} as const;

export function generateLayoutInit(options: GraphGenOptions): LayoutInit {
  const {
    nodeCount,
    communityCount = Math.max(2, Math.round(Math.sqrt(nodeCount))),
    intraDegree = 4,
    interEdgeProb = 0.04,
    seed = 0x9e3779b9,
  } = options;

  const rand = mulberry32(seed);
  const communities = new Int32Array(nodeCount);

  // Contiguous community blocks of (roughly) equal size — cheap, and the
  // layout doesn't care about node ordering.
  const perComm = Math.ceil(nodeCount / communityCount);

  for (let i = 0; i < nodeCount; i++) {
    communities[i] = Math.min(communityCount - 1, Math.floor(i / perComm));
  }

  // Community member index ranges so an intra-edge can pick a same-community
  // partner without rejection-sampling.
  const commStart = new Int32Array(communityCount);
  const commEnd = new Int32Array(communityCount);

  for (let c = 0; c < communityCount; c++) {
    commStart[c] = c * perComm;
    commEnd[c] = Math.min(nodeCount, (c + 1) * perComm);
  }

  const edges: number[] = [];
  const degree = new Int32Array(nodeCount);

  for (let i = 0; i < nodeCount; i++) {
    const c = communities[i]!;
    const lo = commStart[c]!;
    const hi = commEnd[c]!;
    const span = hi - lo;

    // Poisson-ish: `intraDegree` partners on average, never a self-loop.
    const k = span <= 1 ? 0 : 1 + Math.floor(rand() * (intraDegree * 2 - 1));

    for (let e = 0; e < k; e++) {
      let j = lo + Math.floor(rand() * span);

      if (j === i) j = j + 1 < hi ? j + 1 : lo;
      if (j === i) continue;
      edges.push(i, j);
      degree[i]!++;
      degree[j]!++;
    }

    if (rand() < interEdgeProb) {
      const j = Math.floor(rand() * nodeCount);

      if (j !== i && communities[j] !== c) {
        edges.push(i, j);
        degree[i]!++;
        degree[j]!++;
      }
    }
  }

  // Radii mirror the app's degree-driven sizing closely enough for the
  // collide force to do representative work: a sqrt falloff, clamped.
  const radii = new Float32Array(nodeCount);

  for (let i = 0; i < nodeCount; i++) {
    radii[i] = Math.min(20, 4 + Math.sqrt(degree[i]!) * 1.5);
  }

  return {
    nodeCount,
    edges: Int32Array.from(edges),
    communities,
    radii,
    ...DEFAULT_LAYOUT_PARAMS,
  };
}

/** Human-readable shape summary for benchmark labels / logs. */
export function describeGraph(init: LayoutInit): string {
  const distinct = new Set<number>();

  for (let i = 0; i < init.communities.length; i++) distinct.add(init.communities[i]!);

  return `${init.nodeCount} nodes · ${init.edges.length / 2} edges · ${distinct.size} communities`;
}
