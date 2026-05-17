/**
 * Pure d3-force layout simulation, extracted from `layout.worker.ts` so it
 * can run outside a Worker (Node benchmarks, future alternative backends)
 * without dragging in Comlink or the `webworker` lib reference.
 *
 * The worker is now a thin Comlink wrapper around `runLayoutCore`. The only
 * behavioral knob the worker needs that a benchmark doesn't is the
 * between-batch macrotask yield (so a `terminate()` and progress messages
 * can land mid-run); a benchmark wants the tightest possible loop and no
 * event-loop round-trips. Hence the `yieldBetweenBatches` option.
 */
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

export interface RunLayoutOptions {
  onProgress?: LayoutProgress | null;
  /**
   * Yield to the macrotask queue (`setTimeout(0)`) between batches. The
   * worker needs this so an incoming `terminate()` and the progress
   * callback can actually be delivered mid-run. Benchmarks set it `false`
   * to time the raw simulation without event-loop round-trips.
   * @default true
   */
  yieldBetweenBatches?: boolean;
}

/**
 * Run the force-directed simulation to completion and return the final
 * positions buffer (flat `[x0, y0, x1, y1, ...]`). Reports a tick/total
 * pair to `onProgress` between each batch so a long-running layout
 * (several seconds on a 10k-node graph) can drive a progress bar.
 */
export async function runLayoutCore(
  init: LayoutInit,
  options: RunLayoutOptions = {},
): Promise<Float32Array> {
  const { onProgress = null, yieldBetweenBatches = true } = options;
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

  // Inter-cluster springs are the dominant attractive force at scale —
  // a 12k-node graph can have tens of thousands of cross-community
  // edges, each acting as a Hooke spring. With the slider's literal
  // value (e.g. 180), the equilibrium length is far shorter than the
  // natural spread of seeded centroids, so the net effect collapses
  // every cluster into one ball regardless of seeding. Scale the
  // effective distance up with the node count so the equilibrium
  // matches the rough scale of the seeded layout. The slider still
  // controls relative spacing.
  const interDistanceScale = Math.max(1, Math.sqrt(nodeCount / 200));
  const effectiveClusterDistance = clusterDistance * interDistanceScale;

  seedByCommunity(nodes, communities, radii);

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
        .distance(effectiveClusterDistance)
        // Weaker than intra-cluster: at scale, the count of cross-cluster
        // edges easily exceeds intra-cluster ones, and at full strength
        // their cumulative pull dominates the layout and collapses
        // everything to a single ball.
        .strength(0.12),
    )
    .force("center", forceCenter(0, 0).strength(0.005))
    .force("cohesion", communityCohesionForce(communities, cohesion))
    .alpha(1)
    // Slower than d3's default (0.0228) so the same per-tick work
    // delivers more useful motion. Convergence (alpha ≤ alphaMin) lands
    // around tick 340 instead of 135.
    .alphaDecay(0.02)
    .velocityDecay(0.35)
    .stop();

  // Run until the simulation has settled (alpha ≤ alphaMin) or we hit
  // the hard cap. With alphaDecay=0.02 alpha hits alphaMin at ~tick 342,
  // so 500 is a comfortable safety margin. The cap is there so a
  // pathological graph doesn't spin forever. BATCH is small so the
  // worker yields back to the event loop often — when the graph is big
  // each tick can take 30–80ms, and we want progress messages and any
  // pending `terminate` to land between batches.
  const MAX_TICKS = 500;
  const BATCH = 8;
  const alphaMin = sim.alphaMin();
  const logAlphaMin = Math.log(alphaMin);
  let it = 0;

  while (it < MAX_TICKS) {
    const end = Math.min(MAX_TICKS, it + BATCH);

    for (; it < end; it++) sim.tick();
    if (spreadFactor !== 1) applyClusterSpread(nodes, communities, spreadFactor);

    const alpha = sim.alpha();
    // Progress is the further-along of two signals: alpha decay (the
    // intended convergence path) and iteration cap (so the bar can't
    // stall if alpha plateaus above alphaMin somehow).
    const progressByAlpha = alpha <= alphaMin ? 1 : Math.max(0, Math.log(alpha) / logAlphaMin);
    const progressByIter = it / MAX_TICKS;
    const progress = Math.min(1, Math.max(progressByAlpha, progressByIter));

    // Yield between batches so the worker can GC and accept any
    // incoming messages (terminate, etc.). The progress callback fires
    // on the same boundary — it's the main reason to yield at all on
    // small graphs.
    onProgress?.(Math.round(progress * 1000), 1000);
    if (alpha <= alphaMin) break;

    if (it < MAX_TICKS && yieldBetweenBatches) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  onProgress?.(1000, 1000);

  const positions = new Float32Array(nodeCount * 2);

  for (let i = 0; i < nodeCount; i++) {
    const n = nodes[i]!;

    positions[2 * i] = n.x ?? 0;
    positions[2 * i + 1] = n.y ?? 0;
  }

  return positions;
}

function seedByCommunity(nodes: SimNode[], communities: Int32Array, radii: Float32Array): void {
  const counts = new Map<number, number>();
  const radiiSum = new Map<number, number>();

  for (let i = 0; i < nodes.length; i++) {
    const c = communities[i]!;

    counts.set(c, (counts.get(c) ?? 0) + 1);
    radiiSum.set(c, (radiiSum.get(c) ?? 0) + radii[i]!);
  }

  const keys = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)!);
  const centroids = new Map<number, [number, number]>();
  const seedRadii = new Map<number, number>();
  let acc = 0;
  const total = nodes.length;
  const GOLDEN_ANGLE = 137.508 * (Math.PI / 180);

  // Per-community seed disk size: enough room for `count` nodes at their
  // collide radius without overlap. Without this, every node in a
  // community started at the centroid ± 6 units and forceCollide had to
  // do all the dispersion from a single point — fine for small graphs,
  // hopeless at 10k+ nodes within a tight iteration budget.
  for (const c of keys) {
    const count = counts.get(c)!;
    const avgR = radiiSum.get(c)! / count;

    seedRadii.set(c, Math.sqrt(count) * (avgR * 1.5 + 2));
  }

  // Inter-community placement: sunflower spiral, scaled by the sum of
  // per-community seed radii so neighboring clusters don't start
  // overlapping. The old `sqrt(total) * 18` formula assumed everyone
  // started at a point, which is no longer true.
  let seedRadiiTotal = 0;

  for (const r of seedRadii.values()) seedRadiiTotal += r;

  const R = Math.max(Math.sqrt(total) * 18, seedRadiiTotal * 0.8);

  for (let k = 0; k < keys.length; k++) {
    const c = keys[k]!;
    const t = acc / total;
    const angle = k * GOLDEN_ANGLE;
    const radius = R * Math.sqrt(t + 0.02);

    centroids.set(c, [Math.cos(angle) * radius, Math.sin(angle) * radius]);
    acc += counts.get(c)!;
  }

  // Intra-community placement: sunflower pattern inside each cluster so
  // every node lands at a distinct point. Per-community indexing.
  const indexInCommunity = new Map<number, number>();

  for (let i = 0; i < nodes.length; i++) {
    const c = communities[i]!;
    const [cx, cy] = centroids.get(c)!;
    const count = counts.get(c)!;
    const seedR = seedRadii.get(c)!;
    const k = indexInCommunity.get(c) ?? 0;

    indexInCommunity.set(c, k + 1);

    // Sunflower (Vogel) layout — even areal density inside the disk.
    const t = (k + 0.5) / count;
    const localR = seedR * Math.sqrt(t);
    const localAngle = k * GOLDEN_ANGLE;

    nodes[i]!.x = cx + Math.cos(localAngle) * localR;
    nodes[i]!.y = cy + Math.sin(localAngle) * localR;
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
