import { tracked } from "@glimmer/tracking";
import Service, { service } from "@ember/service";

import { getPromiseState, type State } from "reactiveweb/get-promise-state";

import { clusterByLcp, extractClusterStrings, isClusterMode } from "#lib/cluster";
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
  #lastClusterBy: string | null = null;
  #lastSegments: number | null = null;
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
    // URL strings that aren't one of the recognized cluster modes
    // (`id` / `label` / `type` / `meta.<path>`) round down to `null`
    // so the rest of the pipeline only sees "use Louvain" vs. "use
    // these custom communities" — no scattered fallbacks elsewhere.
    const rawMode = this.viewState.clusterBy;
    const clusterBy = isClusterMode(rawMode) ? rawMode : null;
    // Target cluster count for LCP modes — `null` means "natural"
    // (let LCP land wherever the strings diverge). Only consulted
    // when `clusterBy` is non-null; Louvain mode ignores it and
    // continues to use the `clustering` resolution slider.
    const segments = clusterBy !== null ? this.viewState.segments : null;

    if (
      g === this.#lastGraph &&
      clustering === this.#lastClustering &&
      clusterBy === this.#lastClusterBy &&
      segments === this.#lastSegments &&
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
    this.#lastClusterBy = clusterBy;
    this.#lastSegments = segments;

    const pipeline = this.#pipeline!;
    // Custom modes pull a string per node (from id / label / type /
    // meta-path) and dynamically cluster by longest-common-prefix.
    // `segments` (when set) coarsens the result to that many clusters.
    // Computed here (cheap) and injected into the resident session;
    // `null` mode → Louvain runs at `clustering` resolution instead.
    const customCommunities =
      clusterBy !== null ? clusterByLcp(extractClusterStrings(g, clusterBy), segments) : null;

    this.#lastAnalysisPromise = pipeline
      .analyze({ resolution: clustering, communities: customCommunities })
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
   * Cache for the resident Rust session's cycle enumeration. Keyed
   * by `${hiddenEdgeTypes}|${remapFingerprint}` so toggling a type
   * filter or a contraction forces a fresh run, but two callers
   * with the same view share one enumeration.
   *
   * `firstCycleByHidden` is the @tracked sister: set by the
   * streaming `onFirstCycle` callback the moment the BFS finds its
   * first hit (~ first millisecond on most graphs), so `hasAnyCycle`
   * can short-circuit before the full sweep finishes. Reactive
   * consumers re-evaluate when it's reassigned in the callback.
   */
  #cycleGraph: LoadedGraph | null = null;
  #shortestCycleCache = new Map<string, Promise<number[][]>>();
  #hasCycleCache = new Map<string, Promise<boolean>>();
  /** Keys in `#hasCycleCache` filled via the streaming/cache shortcut
   *  rather than the dedicated DFS. Lets us tell a "resolved-true via
   *  shortcut" entry from a pending DFS promise — so when the streaming
   *  signal lands after a pending DFS was already installed, we know to
   *  upgrade the cache. */
  #hasCycleShortcutKeys = new Set<string>();
  @tracked private firstCycleByHidden: Map<string, true> = new Map();

  #resetCycleCachesIfStale(g: LoadedGraph): void {
    if (g !== this.#cycleGraph) {
      this.#cycleGraph = g;
      this.#shortestCycleCache.clear();
      this.#hasCycleCache.clear();
      this.#hasCycleShortcutKeys.clear();
      this.firstCycleByHidden = new Map();
    }
  }

  /**
   * Shortest cycle through each node in each non-trivial SCC, deduped
   * and sorted shortest-first. Polynomial time (`O(V·(V+E))` per SCC),
   * runs in milliseconds even on dense graphs.
   *
   * `nodeRemap` lets the caller hand the resident Rust session a
   * JS-built contraction map (see `buildContraction`). Pass `null`
   * when no contraction is active. The remap is fingerprinted into
   * the cache key so two callers that build the same remap reuse one
   * enumeration; a different remap forces a fresh Rust run.
   *
   * `null` until a graph + session exist.
   */
  cycleShortest(
    hiddenEdgeTypeIds: Int32Array,
    nodeRemap: Int32Array | null,
  ): Promise<number[][]> | null {
    void this.analysis;

    const g = this.graph.current;
    const pipeline = this.#pipeline;

    if (!g || !pipeline) {
      this.#cycleGraph = null;
      this.#shortestCycleCache.clear();
      this.#hasCycleCache.clear();
      this.#hasCycleShortcutKeys.clear();
      this.firstCycleByHidden = new Map();

      return null;
    }

    this.#resetCycleCachesIfStale(g);

    const hiddenKey = hiddenEdgeTypeIds.join(",");
    const remapKey = nodeRemap ? fingerprintRemap(nodeRemap) : "";
    const key = `${hiddenKey}|${remapKey}`;
    let p = this.#shortestCycleCache.get(key);

    if (!p) {
      // Streaming first-cycle callback. Worker calls this back via
      // Comlink.proxy the moment the BFS finds its first hit (~ first
      // millisecond on most graphs). Reassign the @tracked map so
      // anyone reading `firstCycleByHidden` (notably `hasAnyCycle`)
      // re-evaluates immediately — well before the full enumeration
      // finishes.
      p = pipeline.shortestCycles(hiddenEdgeTypeIds, nodeRemap ?? EMPTY_REMAP, () => {
        if (this.firstCycleByHidden.has(hiddenKey)) return;

        const next = new Map(this.firstCycleByHidden);

        next.set(hiddenKey, true);
        this.firstCycleByHidden = next;
      });
      this.#shortestCycleCache.set(key, p);
    }

    return p;
  }

  /**
   * Whether any cycle exists under the edge-type filter.
   *
   * Shares state with `cycleShortest`: when the BFS-per-node
   * enumeration fires its `onFirstCycle` streaming callback we set
   * `firstCycleByHidden[key] = true` and `hasAnyCycle` short-circuits
   * to `Promise.resolve(true)` immediately — even while the rest of
   * the enumeration is still running. Same answer for the case where
   * a `cycleShortest` for this filter has already *resolved* with
   * cycles (e.g., a panel asked first and the result is cached).
   *
   * Falls back to the dedicated O(V+E) coloured-DFS in Rust when
   * neither signal is available — e.g. nobody has asked for
   * `cycleShortest` yet, or the graph genuinely has no cycles.
   *
   * Memoized; same non-blocking contract as the rest. `null` until
   * ready.
   */
  hasAnyCycle(hiddenEdgeTypeIds: Int32Array): Promise<boolean> | null {
    void this.analysis;

    const g = this.graph.current;
    const pipeline = this.#pipeline;

    if (!g || !pipeline) {
      this.#cycleGraph = null;
      this.#shortestCycleCache.clear();
      this.#hasCycleCache.clear();
      this.#hasCycleShortcutKeys.clear();
      this.firstCycleByHidden = new Map();

      return null;
    }

    this.#resetCycleCachesIfStale(g);

    const key = hiddenEdgeTypeIds.join(",");

    // Streaming shortcut. Reading `firstCycleByHidden` (tracked) makes
    // this getter re-evaluate the moment the worker fires its first-
    // cycle callback — much sooner than the full cycleShortest
    // resolution and much, much sooner than queueing a separate DFS
    // call behind it on the single-threaded worker.
    let shortcutTrue = this.firstCycleByHidden.has(key);

    // Also check already-resolved cycleShortest entries (any remap) —
    // a remap can only collapse cycles, not invent them, so a positive
    // contracted result implies the raw graph has cycles. This covers
    // the case where cycleShortest finished before `hasAnyCycle` was
    // first called and the streaming callback already fired.
    if (!shortcutTrue) {
      const prefix = `${key}|`;

      for (const [cacheKey, sp] of this.#shortestCycleCache) {
        if (!cacheKey.startsWith(prefix)) continue;

        const resolved = getPromiseState(sp).resolved;

        if (resolved !== undefined && resolved.length > 0) {
          shortcutTrue = true;

          break;
        }
      }
    }

    if (shortcutTrue) {
      // Upgrade-or-install the cached truthy promise. The shortcut-key
      // set lets us tell a fresh shortcut entry from a pending DFS
      // promise installed before the signal landed.
      if (!this.#hasCycleShortcutKeys.has(key)) {
        this.#hasCycleCache.set(key, Promise.resolve(true));
        this.#hasCycleShortcutKeys.add(key);
      }

      return this.#hasCycleCache.get(key)!;
    }

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
  pendingFocus: { id: string; ts: number; zoomIn?: boolean } | null = null;

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

  /**
   * Like `focusOnId`, but also nudges the camera in a step closer so the
   * node sits centered in the viewport at a slightly tighter zoom. Used by
   * the panel node-link buttons' `dblclick` handler.
   */
  zoomInOnId(id: string): void {
    this.pendingFocus = { id, ts: Date.now(), zoomIn: true };
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
