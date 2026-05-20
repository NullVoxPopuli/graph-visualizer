/// <reference lib="webworker" />

/**
 * Resident graph session worker.
 *
 * The user's JSON crosses into WASM **once** (`load`); after that the
 * graph lives in Rust and the main thread drives it with cheap queries:
 * `setResolution` re-runs Louvain in place, `setCommunities` injects a
 * JS-computed assignment (label-prefix mode), `layout` runs the
 * force-directed simulation. This replaces the old per-change pair of
 * workers (JS graphology Louvain + the layout worker) that re-parsed and
 * re-marshaled the whole graph on every slider move.
 *
 * Comlink (not raw postMessage): these are request/response calls, not a
 * high-frequency buffer stream. WASM calls are synchronous, so Comlink
 * naturally serializes them — the main-thread driver
 * (`session-pipeline.ts`) is responsible for not piling up superseded
 * requests and for ignoring stale results.
 */
import * as Comlink from "comlink";

import init, { GraphSession } from "#lib/wasm/layout_wasm";

/**
 * Progress hook the layout calls once per simulation batch. The caller
 * passes a `Comlink.proxy(...)`-wrapped function so each invocation
 * marshals back across the worker boundary; `null` means no listener.
 */
export type LayoutProgress = (tick: number, total: number) => void;

let wasmReady: Promise<unknown> | null = null;
let session: GraphSession | null = null;

/** Community assignment + display radii for the resident graph. Node
 *  order matches the JS parser's `LoadedGraph` (the Rust parser is a
 *  faithful port — same input-order indexing and edge dedup), so these
 *  index 1:1 with `LoadedGraph.ids`. */
export interface SessionInfo {
  communities: Int32Array;
  communityCount: number;
  radii: Float32Array;
}

export interface LayoutParams {
  repulsion: number;
  nodeDistance: number;
  clusterDistance: number;
}

function activeSession(): GraphSession {
  if (!session) throw new Error("graph-session worker: no graph loaded");

  return session;
}

function readInfo(): SessionInfo {
  const s = activeSession();
  const communities = s.communities();
  const seen = new Set<number>();

  for (let i = 0; i < communities.length; i++) seen.add(communities[i]!);

  return { communities, communityCount: seen.size, radii: s.radii() };
}

const sessionEngine = {
  /**
   * Parse + radii + Louvain (resolution 1) in Rust. Frees any previous
   * session first so switching graphs doesn't leak the old WASM buffers.
   */
  async load(text: string): Promise<SessionInfo> {
    if (!wasmReady) {
      wasmReady = init({
        module_or_path: new URL("./wasm/layout_wasm_bg.wasm", import.meta.url),
      });
    }

    await wasmReady;

    session?.free();
    session = GraphSession.load(text);

    return readInfo();
  },

  /** Re-cluster the resident graph at a new Louvain resolution. */
  setResolution(resolution: number): SessionInfo {
    activeSession().set_resolution(resolution);

    return readInfo();
  },

  /**
   * Replace the community assignment with one computed on the JS side
   * (label-prefix clustering, which has no Louvain analogue).
   */
  setCommunities(communities: Int32Array): SessionInfo {
    activeSession().set_communities(communities);

    return readInfo();
  },

  /**
   * Run the force-directed layout on the resident graph and return the
   * flat positions buffer. Cold (reseed-by-community) every run, matching
   * the previous layout worker's behavior. `onProgress` is a
   * `Comlink.proxy`-wrapped callback so batch ticks can drive the bar.
   */
  layout(params: LayoutParams, onProgress: LayoutProgress | null = null): Float32Array {
    return activeSession().layout(
      1, // spreadFactor — see the visualizer service note on why this is 1
      params.repulsion,
      params.nodeDistance,
      params.clusterDistance,
      0.12, // cohesion
      false, // warm: always cold, equivalent to the old layout worker
      onProgress ? (tick: number, total: number) => onProgress(tick, total) : undefined,
    );
  },

  /**
   * Transitively-orphaned node indices on the resident graph.
   * `hiddenEdgeTypeIds` restricts to visible edges; `rootIndices` are
   * never peeled. Both empty ⇒ the unfiltered analysis. The graph is
   * already resident, so this is a cheap O(N+E) Rust pass — no
   * re-parse, no graph marshaling.
   */
  findOrphans(hiddenEdgeTypeIds: Int32Array, rootIndices: Int32Array): Int32Array {
    return activeSession().find_orphans(hiddenEdgeTypeIds, rootIndices);
  },

  /** Does the resident graph have any orphan under the given edge-type
   *  filter? (empty ⇒ unfiltered.) */
  hasAnyOrphan(hiddenEdgeTypeIds: Int32Array): boolean {
    return activeSession().has_any_orphan(hiddenEdgeTypeIds);
  },

  /** Does the resident graph have any cycle under the given edge-type
   *  filter? (empty ⇒ unfiltered.) */
  hasAnyCycle(hiddenEdgeTypeIds: Int32Array): boolean {
    return activeSession().has_any_cycle(hiddenEdgeTypeIds);
  },

  /**
   * Elementary cycles (Tarjan+Johnson's, exponential-worst-case) as a
   * flat `[len, …nodes, len, …nodes]` buffer.
   *
   * `nodeRemap` is the contraction map (visible→self, hidden→owner,
   * unmappable→-1). Empty means "no contraction — return raw cycles".
   * Non-empty means "enumerate on the contracted CSR" so `maxCycles`
   * bounds *bundled* cycles, not raw ones. Without this, a graph
   * whose raw cycles all sit inside one package collapses to zero
   * bundled cycles after JS contraction; see the do-not-commit.json
   * regression where the contracted graph has a 92-package SCC but
   * Johnson's only saw 30 intra-package raw cycles.
   */
  rawCycles(hiddenEdgeTypeIds: Int32Array, nodeRemap: Int32Array, maxCycles: number): Int32Array {
    return activeSession().raw_cycles(hiddenEdgeTypeIds, nodeRemap, maxCycles);
  },

  /** Drop the resident graph and free its WASM memory. */
  dispose(): void {
    session?.free();
    session = null;
  },
};

export type SessionEngine = typeof sessionEngine;

Comlink.expose(sessionEngine);
