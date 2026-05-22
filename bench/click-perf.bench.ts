/**
 * Click-path micro-bench.
 *
 * Two pieces of work run synchronously every time the user clicks a node
 * in the info-panel / visualizer code path:
 *
 *  1) `bundleAlreadyContractedCycles` — turns the resident Rust session's
 *     shortest-cycle list into the visible-rep bundles the panels show.
 *     Reconstructs the per-step file chain via BFS through each
 *     package's territory. On hub packages with many cycles this is the
 *     dominant cost.
 *  2) "Cycles through a rep" — `Visualizer.repackCycle` and
 *     `InfoPanel.crossPackageCycles` both filter the bundled list down to
 *     the selected node. The naive form (`cycles.filter(c =>
 *     c.includes(rep))`) is O(cycles * avgCycleLen); the per-rep CSR
 *     turns it into O(cycles touching rep).
 *
 * This bench compares the optimized impl (the one shipped in this repo,
 * imported from `#lib/cycle`) against a verbatim inline copy of the
 * pre-PR baseline. Both run on the same synthetic graph, sized to match
 * the user's stress case (large package with many files + many cycles
 * through it). If the speedup isn't visible here, the PR doesn't earn
 * its complexity.
 *
 * Run:  pnpm bench:click            (mitata, default size)
 *       pnpm bench:click 5000,2000  (custom size: nodeCount,cyclesThroughHub)
 *       pnpm bench:click smoke      (one timing pass, prints ms + cycles built)
 *
 * Node 24+ runs this `.ts` directly — no loader needed.
 */
import { bench, group, run, summary } from "mitata";

import {
  bundleAlreadyContractedCycles,
  type BundledWithGroups,
  visualCycleKey,
} from "../app/lib/cycle.ts";

import type { LoadedGraph } from "../app/lib/types.ts";

interface Scenario {
  label: string;
  graph: LoadedGraph;
  nodeRemap: Int32Array;
  rawCycles: number[][];
  hubRep: number;
}

/** mulberry32 — same seeded PRNG the layout bench uses. */
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

interface ScenarioOptions {
  /** Number of packages (reps) in the contracted graph. */
  packageCount: number;
  /** Number of files inside the "hub" package — the one that ends up on
   *  most cycles. The reconstruction BFS scales with this. */
  hubFiles: number;
  /** Mean files per non-hub package. */
  filesPerPackage: number;
  /** Number of cycles that pass through the hub. */
  hubCycles: number;
  /** Cycle length in visible reps (rotated through random packages). */
  cycleLen: number;
  seed?: number;
}

/**
 * Build a synthetic LoadedGraph + cycle list shaped like the user's
 * stress case: a single hub package with `hubFiles` files inside it, all
 * mapped to the hub through a contraction `nodeRemap`. Cycle list has
 * `hubCycles` entries that each start at the hub rep, walk through a few
 * random other packages, and close back. Each cycle's "real" graph path
 * runs through random files inside the hub on the close edge, forcing
 * the per-cycle BFS to walk the hub's territory.
 */
function makeScenario(opts: ScenarioOptions): Scenario {
  const { packageCount, hubFiles, filesPerPackage, hubCycles, cycleLen, seed = 0xa1b2c3d4 } = opts;
  const rand = mulberry32(seed);

  // Layout: indices 0..packageCount-1 are the visible reps (packages).
  // Then `hubFiles` files for the hub, then `filesPerPackage` files for
  // each other package. nodeRemap maps every file to its owning package
  // and every package to itself.
  const totalFiles = hubFiles + (packageCount - 1) * filesPerPackage;
  const N = packageCount + totalFiles;
  const nodeRemap = new Int32Array(N);
  const ids: string[] = [];
  const labels: string[] = [];

  for (let i = 0; i < packageCount; i++) {
    nodeRemap[i] = i;
    ids.push(`@pkg/${i.toString().padStart(4, "0")}`);
    labels.push(ids[i]!);
  }

  // Hub's files
  for (let f = 0; f < hubFiles; f++) {
    const idx = packageCount + f;

    nodeRemap[idx] = 0;
    ids.push(`@pkg/0000/file${f}.ts`);
    labels.push(ids[idx]!);
  }

  // Other packages' files
  let fileCursor = packageCount + hubFiles;

  for (let p = 1; p < packageCount; p++) {
    for (let f = 0; f < filesPerPackage; f++) {
      const idx = fileCursor++;

      nodeRemap[idx] = p;
      ids.push(`@pkg/${p.toString().padStart(4, "0")}/file${f}.ts`);
      labels.push(ids[idx]!);
    }
  }

  // Edges: for every package, link package -> each of its files
  // (a "contain" relationship) and link files in chains so the BFS
  // through a package's territory has somewhere to traverse. Then add
  // one edge per cycle from a hub-file to the next package's rep so
  // the file chain reconstruction has work to do.
  const edgesArr: number[] = [];

  const pushEdge = (a: number, b: number): void => {
    edgesArr.push(a, b);
  };

  // Package -> its files (forms the spine the BFS walks)
  for (let i = packageCount; i < N; i++) {
    pushEdge(nodeRemap[i]!, i);
  }

  // Add intra-hub file -> file edges so the BFS has to wander.
  for (let f = 0; f < hubFiles - 1; f++) {
    pushEdge(packageCount + f, packageCount + f + 1);
  }

  // Generate cycles: each cycle visits the hub rep, then (cycleLen - 1)
  // other random packages, then closes back through a random hub-file.
  const rawCycles: number[][] = [];

  for (let c = 0; c < hubCycles; c++) {
    const cycle: number[] = [];
    const seen = new Set<number>();

    // Pick `cycleLen - 1` distinct non-hub packages to visit.
    const visited: number[] = [];

    while (visited.length < cycleLen - 1) {
      const p = 1 + Math.floor(rand() * (packageCount - 1));

      if (seen.has(p)) continue;
      seen.add(p);
      visited.push(p);
    }

    // Cycle path in raw indices: hub rep -> next pkg rep -> ... -> hub
    // file (varies per cycle so reconstruction can't trivially cache) -> closes.
    cycle.push(0);
    for (const p of visited) cycle.push(p);

    // For the closing edge, attach a hub-file the user's "real" graph
    // would traverse. We push it as a raw cycle node so the
    // already-contracted bundler gets to BFS through it; in practice
    // shortest_cycles returns visible-rep sequences only when the
    // contracted CSR is used, but the BFS work is what we want to
    // exercise, so include it as a hub-territory hop.
    cycle.push(packageCount + (c % hubFiles));
    rawCycles.push(cycle);

    // Add the cycle's closing edges so the BFS can actually find them:
    // last-visited-pkg -> hub-file, hub-file -> hub-rep.
    const lastVisitedPkg = visited[visited.length - 1]!;
    const hubFile = packageCount + (c % hubFiles);

    pushEdge(lastVisitedPkg, hubFile);
    pushEdge(hubFile, 0);
    // Also wire package -> next package directly so the contracted CSR
    // shows a real edge between them. Without this, `cycleShortest`
    // would never have emitted such cycles in the first place; we want
    // bundleAlreadyContractedCycles to see a "plausibly contracted"
    // input where each edge in the bundled cycle reflects an underlying
    // file-level edge.
    pushEdge(0, visited[0]!);

    for (let i = 0; i < visited.length - 1; i++) {
      pushEdge(visited[i]!, visited[i + 1]!);
    }
  }

  const edgesFlat = new Int32Array(edgesArr);
  const E = edgesFlat.length / 2;
  const inDegree = new Int32Array(N);
  const outDegree = new Int32Array(N);

  for (let i = 0; i < E; i++) {
    outDegree[edgesFlat[2 * i]!]!++;
    inDegree[edgesFlat[2 * i + 1]!]!++;
  }

  const graph: LoadedGraph = {
    ids,
    labels,
    edgesFlat,
    edgeTypeIds: new Int32Array(E),
    edgeTypeNames: [""],
    nodeTypeIds: new Int32Array(N),
    nodeTypeNames: [""],
    inDegree,
    outDegree,
    metas: new Array(N).fill(null),
    idToIndex: new Map(ids.map((id, i) => [id, i])),
  };

  return {
    label: `pkgs=${packageCount} hubFiles=${hubFiles} cycles=${hubCycles} len=${cycleLen}`,
    graph,
    nodeRemap,
    rawCycles,
    hubRep: 0,
  };
}

// ---------- Verbatim pre-PR baseline (copied from origin/main) -------------

/** Pre-PR baseline `bundleAlreadyContractedCycles`. */
function bundleAlreadyContractedCyclesBaseline(
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

    const groups = reconstructGroupsBaseline(graph, nodeRemap, c);

    out.push({ bundled: c, groups: groups ?? c.map((idx) => [idx]) });
  }

  out.sort((a, b) => a.bundled.length - b.bundled.length);

  return out;
}

/** Pre-PR baseline `reconstructGroupsForBundledCycle`. */
function reconstructGroupsBaseline(
  graph: LoadedGraph,
  nodeRemap: Int32Array,
  bundled: number[],
): number[][] | null {
  const { edgesFlat } = graph;
  const N = nodeRemap.length;
  const E = edgesFlat.length / 2;
  // Rebuild outgoing CSR per call.
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

// ---------- "cycles through rep" lookup variants -------------

function buildPerRepCsr(N: number, allCycles: number[][]): { idx: Int32Array; edges: Int32Array } {
  const idx = new Int32Array(N + 1);

  for (const c of allCycles) for (const v of c) idx[v + 1]!++;
  for (let i = 0; i < N; i++) idx[i + 1]! += idx[i]!;

  const edges = new Int32Array(idx[N]!);
  const cursor = new Int32Array(N);

  for (let ci = 0; ci < allCycles.length; ci++) {
    for (const v of allCycles[ci]!) {
      edges[idx[v]! + cursor[v]!] = ci;
      cursor[v]!++;
    }
  }

  return { idx, edges };
}

function cyclesThroughCsr(
  rep: number,
  allCycles: number[][],
  csr: { idx: Int32Array; edges: Int32Array },
): number[][] {
  const from = csr.idx[rep]!;
  const to = csr.idx[rep + 1]!;

  if (from === to) return [];

  const seen = new Set<number>();
  const out: number[][] = [];

  for (let i = from; i < to; i++) {
    const ci = csr.edges[i]!;

    if (seen.has(ci)) continue;
    seen.add(ci);
    out.push(allCycles[ci]!);
  }

  return out;
}

function cyclesThroughFilter(rep: number, allCycles: number[][]): number[][] {
  return allCycles.filter((c) => c.includes(rep));
}

// ---------- Bench cases -------------

function defaultCases(): Scenario[] {
  return [
    makeScenario({
      packageCount: 100,
      hubFiles: 1000,
      filesPerPackage: 50,
      hubCycles: 100,
      cycleLen: 4,
    }),
    makeScenario({
      packageCount: 500,
      hubFiles: 1000,
      filesPerPackage: 20,
      hubCycles: 300,
      cycleLen: 5,
    }),
    makeScenario({
      packageCount: 1000,
      hubFiles: 2000,
      filesPerPackage: 10,
      hubCycles: 800,
      cycleLen: 6,
    }),
    // Sparse-hub scenario for the cyclesThrough lookup bench: lots of
    // cycles in the graph but only a small fraction touch the chosen
    // rep, and that rep is not the cycle's first element. This is the
    // case where a per-rep CSR could in principle beat a linear filter
    // scan that has to short-circuit on `.includes` for every cycle.
    makeSparseScenario({
      packageCount: 500,
      cyclesTotal: 1000,
      cyclesTouchingTarget: 30,
      cycleLen: 8,
    }),
  ];
}

/**
 * A graph with `cyclesTotal` bundled cycles, but only
 * `cyclesTouchingTarget` of them mention the bench's chosen `hubRep`
 * (and never in the first slot). Models a graph with many cycles but
 * the user selected a rep that sits on relatively few of them.
 */
function makeSparseScenario(opts: {
  packageCount: number;
  cyclesTotal: number;
  cyclesTouchingTarget: number;
  cycleLen: number;
  seed?: number;
}): Scenario {
  const { packageCount, cyclesTotal, cyclesTouchingTarget, cycleLen, seed = 0xabad1dea } = opts;
  const rand = mulberry32(seed);
  const N = packageCount;
  const nodeRemap = new Int32Array(N);
  const ids: string[] = [];

  for (let i = 0; i < N; i++) {
    nodeRemap[i] = i;
    ids.push(`@pkg/${i.toString().padStart(4, "0")}`);
  }

  // We pick rep 0 as the "target the user clicks." It only appears in
  // `cyclesTouchingTarget` cycles, never in position 0 of any cycle
  // (so .includes can't short-circuit on the first element).
  const target = 0;
  const rawCycles: number[][] = [];

  for (let c = 0; c < cyclesTotal; c++) {
    const cycle: number[] = [];
    const seen = new Set<number>();
    const touchesTarget = c < cyclesTouchingTarget;
    const targetPos = touchesTarget ? 1 + Math.floor(rand() * (cycleLen - 1)) : -1;

    while (cycle.length < cycleLen) {
      if (cycle.length === targetPos) {
        if (!seen.has(target)) {
          cycle.push(target);
          seen.add(target);
        } else {
          // already placed — shouldn't happen since target is unique
          break;
        }

        continue;
      }

      let p: number;

      do {
        p = 1 + Math.floor(rand() * (N - 1));
      } while (seen.has(p));

      cycle.push(p);
      seen.add(p);
    }

    rawCycles.push(cycle);
  }

  // Wire up edges so the BFS reconstruction has something to do.
  const edgesArr: number[] = [];

  for (const cycle of rawCycles) {
    for (let i = 0; i < cycle.length; i++) {
      edgesArr.push(cycle[i]!, cycle[(i + 1) % cycle.length]!);
    }
  }

  const edgesFlat = new Int32Array(edgesArr);
  const E = edgesFlat.length / 2;
  const inDegree = new Int32Array(N);
  const outDegree = new Int32Array(N);

  for (let i = 0; i < E; i++) {
    outDegree[edgesFlat[2 * i]!]!++;
    inDegree[edgesFlat[2 * i + 1]!]!++;
  }

  const graph: LoadedGraph = {
    ids,
    labels: ids,
    edgesFlat,
    edgeTypeIds: new Int32Array(E),
    edgeTypeNames: [""],
    nodeTypeIds: new Int32Array(N),
    nodeTypeNames: [""],
    inDegree,
    outDegree,
    metas: new Array(N).fill(null),
    idToIndex: new Map(ids.map((id, i) => [id, i])),
  };

  return {
    label: `sparse: pkgs=${packageCount} cycles=${cyclesTotal} touching=${cyclesTouchingTarget} len=${cycleLen}`,
    graph,
    nodeRemap,
    rawCycles,
    hubRep: target,
  };
}

function parseSizes(arg: string | undefined): Scenario[] {
  if (!arg || arg === "smoke") return defaultCases();

  // Custom shape: pkgs,hubFiles,cycles,cycleLen
  const parts = arg.split(",").map((s) => parseInt(s.trim(), 10));

  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n) || n <= 0)) {
    return defaultCases();
  }

  const [packageCount, hubFiles, hubCycles, cycleLen = 5] = parts;

  return [
    makeScenario({
      packageCount: packageCount!,
      hubFiles: hubFiles!,
      filesPerPackage: 10,
      hubCycles: hubCycles!,
      cycleLen,
    }),
  ];
}

function smoke(cases: Scenario[]): void {
  for (const sc of cases) {
    const allCyclesBaseline = bundleAlreadyContractedCyclesBaseline(
      sc.graph,
      sc.nodeRemap,
      sc.rawCycles,
    ).map((b) => b.bundled);
    const allCyclesNew = bundleAlreadyContractedCycles(sc.graph, sc.nodeRemap, sc.rawCycles).map(
      (b) => b.bundled,
    );

    if (allCyclesNew.length !== allCyclesBaseline.length) {
      throw new Error(`parity: new=${allCyclesNew.length} baseline=${allCyclesBaseline.length}`);
    }

    const t0 = performance.now();

    bundleAlreadyContractedCyclesBaseline(sc.graph, sc.nodeRemap, sc.rawCycles);

    const baseMs = performance.now() - t0;

    const t1 = performance.now();

    bundleAlreadyContractedCycles(sc.graph, sc.nodeRemap, sc.rawCycles);

    const newMs = performance.now() - t1;

    const csr = buildPerRepCsr(sc.nodeRemap.length, allCyclesNew);
    const t2 = performance.now();

    for (let i = 0; i < 50; i++) cyclesThroughFilter(sc.hubRep, allCyclesNew);

    const filterMs = (performance.now() - t2) / 50;

    const t3 = performance.now();

    for (let i = 0; i < 50; i++) cyclesThroughCsr(sc.hubRep, allCyclesNew, csr);

    const csrMs = (performance.now() - t3) / 50;

    console.info(`\n${sc.label}`);
    console.info(`  bundle baseline      ${baseMs.toFixed(2).padStart(8)} ms`);
    console.info(`  bundle new           ${newMs.toFixed(2).padStart(8)} ms`);
    console.info(`  cyclesThrough filter ${filterMs.toFixed(3).padStart(8)} ms/op`);
    console.info(`  cyclesThrough csr    ${csrMs.toFixed(3).padStart(8)} ms/op`);
    console.info(
      `  cycles built: ${allCyclesNew.length}, hubRep cycles: ${cyclesThroughCsr(sc.hubRep, allCyclesNew, csr).length}`,
    );
  }
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const cases = parseSizes(process.argv[3] ?? arg);

  if (arg === "smoke") {
    smoke(cases);

    return;
  }

  for (const sc of cases) {
    const allCyclesNew = bundleAlreadyContractedCycles(sc.graph, sc.nodeRemap, sc.rawCycles).map(
      (b) => b.bundled,
    );
    const csr = buildPerRepCsr(sc.nodeRemap.length, allCyclesNew);

    group(sc.label, () => {
      summary(() => {
        bench("bundleAlreadyContractedCycles — baseline", () => {
          bundleAlreadyContractedCyclesBaseline(sc.graph, sc.nodeRemap, sc.rawCycles);
        });
        bench("bundleAlreadyContractedCycles — new", () => {
          bundleAlreadyContractedCycles(sc.graph, sc.nodeRemap, sc.rawCycles);
        });
      });
      summary(() => {
        bench("cyclesThrough(hub) — filter+includes", () => {
          cyclesThroughFilter(sc.hubRep, allCyclesNew);
        });
        bench("cyclesThrough(hub) — per-rep CSR", () => {
          cyclesThroughCsr(sc.hubRep, allCyclesNew, csr);
        });
      });
    });
  }

  await run();
}

await main();
