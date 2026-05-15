/// <reference lib="webworker" />
import * as Comlink from "comlink";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";

interface SimNode extends SimulationNodeDatum {
  id: number;
}

export interface LayoutInit {
  nodeCount: number;
  edges: Int32Array;
  communities: Int32Array;
  /** Display radius per node (world units). Drives `forceCollide` so bigger
   *  nodes carve out proportionally more space and don't overlap small ones. */
  radii: Float32Array;
  spreadFactor: number;
  repulsion: number;
  /** Equilibrium distance for edges that stay inside a single community. */
  nodeDistance: number;
  /** Equilibrium distance for edges that cross a community boundary. */
  clusterDistance: number;
  cohesion: number;
}

/**
 * Optional progress hook the worker calls between simulation batches. The
 * caller passes a `Comlink.proxy(...)`-wrapped function from the main
 * thread so each invocation marshals back through the worker boundary.
 * `null` is fine — no overhead when no listener cares.
 */
export type LayoutProgress = (tick: number, total: number) => void;

const layoutEngine = {
  /**
   * Run the force-directed simulation to completion and return the final
   * positions buffer. Reports a tick/total pair to `onProgress` between
   * each batch so a long-running layout (several seconds on a 10k-node
   * graph) can drive a progress bar.
   */
  async run(init: LayoutInit, onProgress: LayoutProgress | null = null): Promise<Float32Array> {
    const {
      nodeCount,
      edges,
      communities,
      radii,
      spreadFactor,
      repulsion,
      nodeDistance,
      clusterDistance,
      cohesion,
    } = init;

    const nodes: SimNode[] = [];

    for (let i = 0; i < nodeCount; i++) nodes.push({ id: i });

    // Split links by whether they cross a community boundary. Most edges in
    // a Louvain-clustered graph are intra-cluster — using one `link` force
    // for both means `springLength` mostly tunes within-cluster spacing,
    // and after the auto-fit camera normalizes the result the slider looks
    // like a no-op. Pulling inter-cluster edges out lets `springLength`
    // actually push communities apart.
    const intraLinks: SimulationLinkDatum<SimNode>[] = [];
    const interLinks: SimulationLinkDatum<SimNode>[] = [];

    for (let i = 0; i < edges.length; i += 2) {
      const a = edges[i]!;
      const b = edges[i + 1]!;

      if (a === b) continue;

      const link: SimulationLinkDatum<SimNode> = { source: a, target: b };

      if (communities[a] === communities[b]) intraLinks.push(link);
      else interLinks.push(link);
    }

    seedByCommunity(nodes, communities);

    const sim: Simulation<SimNode, SimulationLinkDatum<SimNode>> = forceSimulation(nodes)
      .force(
        "charge",
        forceManyBody<SimNode>()
          // Bigger nodes push their neighborhood out harder. `sqrt` so a
          // single high-degree hub doesn't dominate the layout — degree 100
          // is only ~3× degree 10 in repulsion, not 10×.
          .strength((d) => -Math.abs(repulsion) * 6 * Math.sqrt(radii[d.id]! / 5))
          .theta(0.9),
      )
      // Hard-ish keep-out: no two nodes' bodies overlap. The radius factor
      // adds a little breathing room past the visible body for incoming
      // arrows and labels.
      .force(
        "collide",
        forceCollide<SimNode>()
          .radius((d) => radii[d.id]! * 1.5 + 2)
          .strength(0.85)
          .iterations(2),
      )
      .force(
        "intraLink",
        forceLink<SimNode, SimulationLinkDatum<SimNode>>(intraLinks)
          .id((n) => n.id)
          .distance(nodeDistance)
          .strength(0.5),
      )
      .force(
        "interLink",
        forceLink<SimNode, SimulationLinkDatum<SimNode>>(interLinks)
          .id((n) => n.id)
          .distance(clusterDistance)
          .strength(0.5),
      )
      .force("center", forceCenter(0, 0).strength(0.02))
      .force("cohesion", communityCohesionForce(communities, cohesion))
      .alpha(1)
      .alphaDecay(0.05)
      .velocityDecay(0.35)
      .stop();

    const TOTAL = 180;
    const BATCH = 15;
    let it = 0;

    while (it < TOTAL) {
      const end = Math.min(TOTAL, it + BATCH);

      for (; it < end; it++) sim.tick();
      if (spreadFactor !== 1) applyClusterSpread(nodes, communities, spreadFactor);
      // Yield between batches so the worker can GC and accept any
      // incoming messages (terminate, etc.). The progress callback fires
      // on the same boundary — it's the main reason to yield at all on
      // small graphs.
      onProgress?.(it, TOTAL);
      if (it < TOTAL) await new Promise((resolve) => setTimeout(resolve, 0));
    }

    onProgress?.(TOTAL, TOTAL);

    const positions = new Float32Array(nodeCount * 2);

    for (let i = 0; i < nodeCount; i++) {
      const n = nodes[i]!;

      positions[2 * i] = n.x ?? 0;
      positions[2 * i + 1] = n.y ?? 0;
    }

    return positions;
  },
};

export type LayoutEngine = typeof layoutEngine;

Comlink.expose(layoutEngine);

function seedByCommunity(nodes: SimNode[], communities: Int32Array): void {
  const counts = new Map<number, number>();

  for (let i = 0; i < nodes.length; i++) {
    const c = communities[i]!;

    counts.set(c, (counts.get(c) ?? 0) + 1);
  }

  const keys = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)!);
  const centroids = new Map<number, [number, number]>();
  let acc = 0;
  const total = nodes.length;
  const R = Math.sqrt(total) * 18;

  for (let k = 0; k < keys.length; k++) {
    const c = keys[k]!;
    const t = acc / total;
    const angle = k * 137.508 * (Math.PI / 180);
    const radius = R * Math.sqrt(t + 0.02);

    centroids.set(c, [Math.cos(angle) * radius, Math.sin(angle) * radius]);
    acc += counts.get(c)!;
  }

  for (let i = 0; i < nodes.length; i++) {
    const c = communities[i]!;
    const [cx, cy] = centroids.get(c)!;

    nodes[i]!.x = cx + (Math.random() - 0.5) * 12;
    nodes[i]!.y = cy + (Math.random() - 0.5) * 12;
  }
}

function communityCohesionForce(
  communities: Int32Array,
  strength: number,
): (alpha: number) => void {
  let nodes: SimNode[] = [];
  let maxComm = 0;

  for (let i = 0; i < communities.length; i++) {
    if (communities[i]! > maxComm) maxComm = communities[i]!;
  }

  const MAX_INDEXED_COMM = 200_000;
  const cap = Math.min(maxComm + 1, MAX_INDEXED_COMM);
  const sumX = new Float64Array(cap);
  const sumY = new Float64Array(cap);
  const counts = new Int32Array(cap);

  const force = (alpha: number): void => {
    if (strength <= 0 || nodes.length === 0) return;
    sumX.fill(0);
    sumY.fill(0);
    counts.fill(0);

    for (let i = 0; i < nodes.length; i++) {
      const c = communities[i]!;

      if (c < 0 || c >= cap) continue;

      const n = nodes[i]!;

      sumX[c]! += n.x ?? 0;
      sumY[c]! += n.y ?? 0;
      counts[c]!++;
    }

    for (let i = 0; i < nodes.length; i++) {
      const c = communities[i]!;

      if (c < 0 || c >= cap) continue;

      const k = counts[c]!;

      if (k <= 1) continue;

      const cx = sumX[c]! / k;
      const cy = sumY[c]! / k;
      const n = nodes[i]!;

      n.vx = (n.vx ?? 0) + (cx - (n.x ?? 0)) * strength * alpha;
      n.vy = (n.vy ?? 0) + (cy - (n.y ?? 0)) * strength * alpha;
    }
  };

  (force as { initialize?: (n: SimNode[]) => void }).initialize = (n: SimNode[]) => {
    nodes = n;
  };

  return force;
}

function applyClusterSpread(nodes: SimNode[], communities: Int32Array, spreadFactor: number): void {
  let maxComm = 0;

  for (let i = 0; i < communities.length; i++) {
    if (communities[i]! > maxComm) maxComm = communities[i]!;
  }

  const MAX_INDEXED_COMM = 200_000;
  const cap = Math.min(maxComm + 1, MAX_INDEXED_COMM);
  const sumX = new Float64Array(cap);
  const sumY = new Float64Array(cap);
  const counts = new Int32Array(cap);
  let gx = 0;
  let gy = 0;

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const c = communities[i]!;

    gx += x;
    gy += y;
    if (c < 0 || c >= cap) continue;
    sumX[c]! += x;
    sumY[c]! += y;
    counts[c]!++;
  }

  gx /= nodes.length;
  gy /= nodes.length;

  const shiftX = new Float64Array(cap);
  const shiftY = new Float64Array(cap);

  for (let c = 0; c < cap; c++) {
    const k = counts[c]!;

    if (k === 0) continue;
    shiftX[c] = (spreadFactor - 1) * (sumX[c]! / k - gx);
    shiftY[c] = (spreadFactor - 1) * (sumY[c]! / k - gy);
  }

  for (let i = 0; i < nodes.length; i++) {
    const c = communities[i]!;

    if (c < 0 || c >= cap) continue;

    const n = nodes[i]!;

    n.x = (n.x ?? 0) + shiftX[c]!;
    n.y = (n.y ?? 0) + shiftY[c]!;
  }
}
