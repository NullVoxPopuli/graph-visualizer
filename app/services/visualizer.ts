import { tracked } from "@glimmer/tracking";
import Service, { service } from "@ember/service";

import { getPromiseState, type State } from "reactiveweb/get-promise-state";

import { SessionPipeline } from "#lib/session-pipeline";

import type GraphService from "./graph";
import type ViewStateService from "./view-state";
import type { LoadedGraph } from "#lib/types";

interface Analysis {
  graph: LoadedGraph;
  communities: Int32Array;
  communityCount: number;
  radii: Float32Array;
}

/**
 * The result of running the heavy pipeline (community detection + force
 * layout) over the currently-loaded graph. Held only inside the promise
 * resolved value — there's no parallel mutable state to keep in sync.
 */
export interface ProcessedScene {
  graph: LoadedGraph;
  positions: Float32Array;
  communities: Int32Array;
  communityCount: number;
  radii: Float32Array;
}

/**
 * Singleton that owns the pipeline for the currently-viewed graph.
 *
 * Everything user-visible (counts, ready state, the position/community
 * buffers the renderer needs) is **derived** — there is no tracked
 * application state to keep coherent. The only thing flowing through here
 * is a promise (computed from `graph.current`) whose state is exposed via
 * `getPromiseState`.
 *
 * "You can only view one thing at a time" — i.e. one graph maps to one
 * pipeline — so a service is the natural home: any component that needs to
 * read the scene gets the same instance, and switching graphs is just
 * `graph.load(next)` (which invalidates the cached promise).
 */
export default class VisualizerService extends Service {
  @service declare graph: GraphService;
  @service declare viewState: ViewStateService;

  /**
   * One resident WASM session per loaded graph. The JSON is parsed into
   * Rust once; clustering and layout are then cheap in-place queries on
   * it. Recreated (old session freed) only when a *different* graph is
   * loaded — not on slider moves.
   */
  #pipeline: SessionPipeline | null = null;
  #pipelineGraph: LoadedGraph | null = null;

  #disposePipeline(): void {
    this.#pipeline?.dispose();
    this.#pipeline = null;
    this.#pipelineGraph = null;
  }

  /**
   * Community detection + radii. Depends on graph topology and the
   * Louvain `resolution` slider (or the label-prefix grouping toggle).
   * Manually memoized by value — `@cached` here would invalidate on every
   * QP write (the resolution read tracks `router.currentRoute`), forcing
   * a worker rerun per click.
   *
   * Cancellation: the session is *resident*, so superseded runs aren't
   * cancelled by terminating the worker (that would throw away the parsed
   * graph). A clustering change just issues a new in-place query and
   * replaces `#lastAnalysisPromise`; any in-flight older promise still
   * resolves but is no longer referenced, so nothing observes it. The
   * worker is only torn down when the graph itself changes.
   */
  #lastGraph: LoadedGraph | null = null;
  #lastClustering = Number.NaN;
  #lastClusterByLabel = false;
  #lastAnalysisPromise: Promise<Analysis> | null = null;

  get analysis(): Promise<Analysis> | null {
    const g = this.graph.current;
    const text = this.graph.currentText;

    if (!g || !text) {
      this.#disposePipeline();
      this.#lastGraph = null;
      this.#lastAnalysisPromise = null;

      return null;
    }

    const clustering = this.viewState.clustering;
    const clusterByLabel = this.viewState.clusterByLabel;

    if (
      g === this.#lastGraph &&
      clustering === this.#lastClustering &&
      clusterByLabel === this.#lastClusterByLabel &&
      this.#lastAnalysisPromise !== null
    ) {
      return this.#lastAnalysisPromise;
    }

    // A different graph → fresh resident session (frees the old one).
    if (g !== this.#pipelineGraph) {
      this.#disposePipeline();
      this.#pipeline = new SessionPipeline(text);
      this.#pipelineGraph = g;
    }

    this.#lastGraph = g;
    this.#lastClustering = clustering;
    this.#lastClusterByLabel = clusterByLabel;

    const pipeline = this.#pipeline!;
    // Label-prefix grouping has no Louvain analogue — compute it here
    // (cheap string ops) and inject it into the resident session.
    const labelCommunities = clusterByLabel ? clusterByLabelPrefix(g) : null;

    this.#lastAnalysisPromise = pipeline
      .analyze({ clusterByLabel, resolution: clustering, labelCommunities })
      .then(
        (info): Analysis => ({
          graph: g,
          communities: info.communities,
          communityCount: info.communityCount,
          radii: info.radii,
        }),
      );

    return this.#lastAnalysisPromise;
  }

  /**
   * Full pipeline: analysis + layout. Recomputed when `graph.current`
   * changes (via the cached `analysis`) and when the layout sliders
   * (repulsion, spring length) actually move.
   *
   * Manually memoized by value rather than `@cached`: reading
   * `viewState.repulsion` / `viewState.springLength` tracks
   * `router.currentRoute`, which churns on every QP write (selection, etc.).
   * `@cached` would invalidate on that churn and hand out a fresh promise
   * each click — the new `ProcessedScene` reference would then trip the
   * "re-fit" path in the renderer component.
   *
   * `#layoutEpoch` is the cancellation token: only the latest run writes
   * progress / resolves into the renderer. The `SessionPipeline` itself
   * collapses superseded layout requests so the worker never runs more
   * than the newest one.
   */
  #lastAnalysis: Promise<Analysis> | null = null;
  #lastRepulsion = Number.NaN;
  #lastNodeDistance = Number.NaN;
  #lastClusterDistance = Number.NaN;
  #lastProcessing: Promise<ProcessedScene> | null = null;
  #layoutEpoch = 0;

  get processing(): Promise<ProcessedScene> | null {
    const a = this.analysis;

    if (a === null) {
      this.#lastAnalysis = null;
      this.#lastProcessing = null;

      return null;
    }

    const repulsion = this.viewState.repulsion;
    const nodeDistance = this.viewState.nodeDistance;
    const clusterDistance = this.viewState.clusterDistance;

    if (
      a === this.#lastAnalysis &&
      repulsion === this.#lastRepulsion &&
      nodeDistance === this.#lastNodeDistance &&
      clusterDistance === this.#lastClusterDistance &&
      this.#lastProcessing !== null
    ) {
      return this.#lastProcessing;
    }

    this.#lastAnalysis = a;
    this.#lastRepulsion = repulsion;
    this.#lastNodeDistance = nodeDistance;
    this.#lastClusterDistance = clusterDistance;

    const epoch = ++this.#layoutEpoch;

    this.layoutProgress = { tick: 0, total: 1 };
    this.#lastProcessing = a.then(async (analysis) => {
      const pipeline = this.#pipeline;

      // Superseded before layout began (clustering moved again, or the
      // graph was swapped). The cached promise has already been replaced,
      // so a never-resolving promise here just keeps this stale scene
      // from ever reaching the renderer — matching the old behavior where
      // a terminated worker's Comlink call hung forever.
      if (!pipeline || epoch !== this.#layoutEpoch) {
        return new Promise<ProcessedScene>(() => {});
      }

      const positions = await pipeline.layout(
        { repulsion, nodeDistance, clusterDistance },
        (tick, total) => {
          // Only the latest run owns the progress bar.
          if (epoch === this.#layoutEpoch) {
            this.layoutProgress = { tick, total };
          }
        },
      );

      if (epoch === this.#layoutEpoch) {
        this.layoutProgress = null;
      }

      return {
        graph: analysis.graph,
        positions,
        communities: analysis.communities,
        communityCount: analysis.communityCount,
        radii: analysis.radii,
      };
    });

    return this.#lastProcessing;
  }

  /**
   * Progress feedback for the in-flight layout simulation. `null` when no
   * layout is running (either nothing's loaded or the last run finished).
   * Tracked so the loading overlay re-renders as new ticks arrive.
   */
  @tracked layoutProgress: { tick: number; total: number } | null = null;

  /** isLoading / error / resolved on the active processing promise. */
  get state(): State<ProcessedScene> | null {
    return this.processing === null ? null : getPromiseState(this.processing);
  }

  /** True once the pipeline has produced a scene. */
  get isReady(): boolean {
    return this.state?.resolved !== undefined;
  }

  /** The resolved scene, if ready. */
  get scene(): ProcessedScene | null {
    return this.state?.resolved ?? null;
  }

  // Counts the HUD wants. Node/edge counts are immediately available from
  // the loaded graph; community count comes from the resolved pipeline.
  get nodeCount(): number {
    return this.graph.current?.ids.length ?? 0;
  }

  get edgeCount(): number {
    return (this.graph.current?.edgesFlat.length ?? 0) / 2;
  }

  get communityCount(): number {
    return this.scene?.communityCount ?? 0;
  }

  /**
   * Transitively-orphaned node indices, computed in the resident Rust
   * session (no JS duplicate). Memoized per (graph, filter content): it
   * runs once per distinct filter state and is reused across the many
   * renders that don't change filters — recomputed only when the user
   * actually toggles an edge-type filter or declares a root. Panels read
   * the resolved value via `getPromiseState`, so the UI never blocks on
   * it. `null` until a graph + its session exist.
   *
   * The two args are content-keyed; pass stable `Int32Array`s built from
   * the view-state sets.
   */
  #orphanGraph: LoadedGraph | null = null;
  #orphanCache = new Map<string, Promise<Int32Array>>();

  orphanIndices(
    hiddenEdgeTypeIds: Int32Array,
    rootIndices: Int32Array,
  ): Promise<Int32Array> | null {
    // Touch `analysis` so the resident pipeline exists for the current
    // graph (the analysis getter owns the session lifecycle).
    void this.analysis;

    const g = this.graph.current;
    const pipeline = this.#pipeline;

    if (!g || !pipeline) {
      this.#orphanGraph = null;
      this.#orphanCache.clear();

      return null;
    }

    if (g !== this.#orphanGraph) {
      this.#orphanGraph = g;
      this.#orphanCache.clear();
    }

    const key = `${hiddenEdgeTypeIds.join(",")}|${rootIndices.join(",")}`;
    let p = this.#orphanCache.get(key);

    if (!p) {
      p = pipeline.findOrphans(hiddenEdgeTypeIds, rootIndices);
      this.#orphanCache.set(key, p);
    }

    return p;
  }

  /**
   * Elementary cycles computed in the resident Rust session as
   * `number[][]` node-index lists. Memoized per (graph, edge-type
   * filter, node-contraction map): the remap key matters because Rust
   * enumerates on the *contracted* CSR when a remap is passed — so a
   * type-toggle forces a fresh run. Same non-blocking promise-state
   * contract as `orphanIndices`. `null` until a graph + session exist.
   *
   * Enumeration is unbounded (Johnson's, exponential worst case);
   * runs in the worker so the main thread stays responsive.
   */
  #cycleGraph: LoadedGraph | null = null;
  #cycleCache = new Map<string, Promise<number[][]>>();
  #hasCycleCache = new Map<string, Promise<boolean>>();

  #resetCycleCachesIfStale(g: LoadedGraph): void {
    if (g !== this.#cycleGraph) {
      this.#cycleGraph = g;
      this.#cycleCache.clear();
      this.#hasCycleCache.clear();
    }
  }

  /**
   * `nodeRemap` lets the caller hand the resident Rust session a JS-built
   * contraction map (see `buildContraction`). Pass `null` when no
   * contraction is active. The remap is fingerprinted into the cache key
   * — two callers that build the same remap reuse one enumeration, but
   * toggling a node-type filter forces a fresh Rust run.
   */
  cycleRaw(
    hiddenEdgeTypeIds: Int32Array,
    nodeRemap: Int32Array | null,
  ): Promise<number[][]> | null {
    void this.analysis;

    const g = this.graph.current;
    const pipeline = this.#pipeline;

    if (!g || !pipeline) {
      this.#cycleGraph = null;
      this.#cycleCache.clear();
      this.#hasCycleCache.clear();

      return null;
    }

    this.#resetCycleCachesIfStale(g);

    // Empty remap == "no contraction" on the Rust side. Hashing it into
    // the key keeps every distinct visibility filter as its own cached
    // entry; without that, toggling a type would silently reuse stale
    // cycles enumerated on a different remap.
    const remapKey = nodeRemap ? fingerprintRemap(nodeRemap) : "";
    const key = `${hiddenEdgeTypeIds.join(",")}|${remapKey}`;
    let p = this.#cycleCache.get(key);

    if (!p) {
      p = pipeline.rawCycles(hiddenEdgeTypeIds, nodeRemap ?? EMPTY_REMAP);
      this.#cycleCache.set(key, p);
    }

    return p;
  }

  /** Whether any cycle exists under the edge-type filter. Memoized;
   *  same non-blocking contract as the rest. `null` until ready. */
  hasAnyCycle(hiddenEdgeTypeIds: Int32Array): Promise<boolean> | null {
    void this.analysis;

    const g = this.graph.current;
    const pipeline = this.#pipeline;

    if (!g || !pipeline) {
      this.#cycleGraph = null;
      this.#cycleCache.clear();
      this.#hasCycleCache.clear();

      return null;
    }

    this.#resetCycleCachesIfStale(g);

    const key = hiddenEdgeTypeIds.join(",");
    let p = this.#hasCycleCache.get(key);

    if (!p) {
      p = pipeline.hasAnyCycle(hiddenEdgeTypeIds);
      this.#hasCycleCache.set(key, p);
    }

    return p;
  }

  /**
   * Cross-component pan-to request. Set by the search component (and
   * anything else that wants to bring a node into view); polled and
   * cleared by the Visualizer component's rAF loop. Not tracked — the
   * polling is imperative, and we don't want every read to subscribe.
   */
  pendingFocus: { id: string; ts: number } | null = null;

  /**
   * Node id currently hovered from outside the canvas (info-panel rows,
   * search results, etc.). Polled by the Visualizer's rAF loop and folded
   * into the same hover-grow visual that on-canvas mouse hover uses. Not
   * tracked.
   */
  externalHoverId: string | null = null;

  /**
   * Ask the renderer to bring the node with this id into view (used by
   * search). The component reads the request next frame and pans/animates
   * if the node is outside the current viewport.
   */
  focusOnId(id: string): void {
    this.pendingFocus = { id, ts: Date.now() };
  }
}

/** Shared sentinel for "no contraction" — passing the same instance to the
 *  worker means Comlink doesn't allocate a fresh transferable on each call. */
const EMPTY_REMAP = new Int32Array(0);

/**
 * Stable string fingerprint of a `nodeRemap` slice for cycle-cache keying.
 * The full `nodeRemap.join(",")` would be O(N) per cycle-panel render and
 * grow with the graph; this 64-bit FNV-1a digest is O(N) but constant-size,
 * and identical remaps always hash to the same string.
 */
function fingerprintRemap(remap: Int32Array): string {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0xcbf29ce4 >>> 0;

  for (let i = 0; i < remap.length; i++) {
    const v = remap[i]! | 0;

    h1 ^= v;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= v ^ (i & 0xff);
    h2 = Math.imul(h2, 0x01000193);
  }

  return `${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}:${remap.length}`;
}

/**
 * Group nodes by their label's parent prefix — everything before the last
 * "/" or "." separator, whichever appears later. Falls back to the whole
 * label when the label has no separator, so an `index.ts` and an `app.css`
 * at the root end up in their own buckets but `src/foo/a.ts` and
 * `src/foo/b.ts` cluster together as `src/foo`.
 */
function clusterByLabelPrefix(graph: LoadedGraph): Int32Array {
  const N = graph.labels.length;
  const communities = new Int32Array(N);
  const bucket = new Map<string, number>();

  for (let i = 0; i < N; i++) {
    const key = labelPrefix(graph.labels[i] ?? "");
    let id = bucket.get(key);

    if (id === undefined) {
      id = bucket.size;
      bucket.set(key, id);
    }

    communities[i] = id;
  }

  return communities;
}

function labelPrefix(label: string): string {
  // Prefer "/" — paths group by parent directory. Fall back to "." only when
  // there's no slash, so dotted namespaces like `com.foo.Bar` still cluster
  // (`com.foo`). Naively taking the rightmost "/" or "." would treat the
  // extension as a separator and put every file in its own bucket.
  const slash = label.lastIndexOf("/");

  if (slash > 0) return label.slice(0, slash);

  const dot = label.lastIndexOf(".");

  if (dot > 0) return label.slice(0, dot);

  return label;
}
