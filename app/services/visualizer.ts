import Service, { service } from "@ember/service";
import { tracked } from "@glimmer/tracking";

import * as Comlink from "comlink";
import { getPromiseState, type State } from "reactiveweb/get-promise-state";

import { computeRadii } from "#lib/pack";

import type GraphService from "./graph";
import type ViewStateService from "./view-state";
import type { AnalyzeEngine, AnalyzeInit } from "#lib/analyze.worker";
import type { LayoutEngine, LayoutInit } from "#lib/layout.worker";
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
   * Community detection + radii. Depends on graph topology and the
   * Louvain `resolution` slider. Manually memoized by value — `@cached`
   * here would invalidate on every QP write (the resolution read tracks
   * `router.currentRoute`), forcing a worker rerun per click.
   */
  #lastGraph: LoadedGraph | null = null;
  #lastClustering = Number.NaN;
  #lastClusterByLabel = false;
  #lastAnalysisPromise: Promise<Analysis> | null = null;

  get analysis(): Promise<Analysis> | null {
    const g = this.graph.current;

    if (!g) {
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

    this.#lastGraph = g;
    this.#lastClustering = clustering;
    this.#lastClusterByLabel = clusterByLabel;
    this.#lastAnalysisPromise = runAnalysis(g, clustering, clusterByLabel);

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
   */
  #lastAnalysis: Promise<Analysis> | null = null;
  #lastRepulsion = Number.NaN;
  #lastNodeDistance = Number.NaN;
  #lastClusterDistance = Number.NaN;
  #lastProcessing: Promise<ProcessedScene> | null = null;

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
    this.layoutProgress = { tick: 0, total: 1 };
    this.#lastProcessing = a.then(async (analysis) => {
      const positions = await runLayout(
        analysis.graph,
        analysis.communities,
        analysis.radii,
        {
          repulsion,
          nodeDistance,
          clusterDistance,
        },
        (tick, total) => {
          this.layoutProgress = { tick, total };
        },
      );

      this.layoutProgress = null;

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

/**
 * Run the analyze worker on the given graph. The worker is spawned per call
 * and terminated as soon as the result is back — there's no long-lived
 * background work to manage.
 */
async function runAnalyze(graph: LoadedGraph, resolution: number): Promise<Int32Array> {
  const worker = new Worker(new URL("../lib/analyze.worker.ts", import.meta.url), {
    type: "module",
  });
  const analyze = Comlink.wrap<AnalyzeEngine>(worker);

  try {
    const init: AnalyzeInit = {
      nodeCount: graph.ids.length,
      edges: graph.edgesFlat,
      resolution,
    };
    const result = await analyze.run(init);

    return result.communities;
  } finally {
    worker.terminate();
  }
}

/**
 * Run the d3-force layout worker to completion. Returns the final positions
 * buffer; intermediate ticks are no longer surfaced.
 */
async function runLayout(
  graph: LoadedGraph,
  communities: Int32Array,
  radii: Float32Array,
  params: { repulsion: number; nodeDistance: number; clusterDistance: number },
  onProgress?: (tick: number, total: number) => void,
): Promise<Float32Array> {
  const worker = new Worker(new URL("../lib/layout.worker.ts", import.meta.url), {
    type: "module",
  });
  const layout = Comlink.wrap<LayoutEngine>(worker);

  try {
    const init: LayoutInit = {
      nodeCount: graph.ids.length,
      edges: graph.edgesFlat,
      communities,
      radii,
      // The per-batch cluster spread used to amplify positions ~9x, which
      // dwarfed the spring/charge forces and meant the sliders had no
      // visible effect after auto-fit normalized the result.
      spreadFactor: 1,
      repulsion: params.repulsion,
      nodeDistance: params.nodeDistance,
      clusterDistance: params.clusterDistance,
      cohesion: 0.12,
    };

    // Comlink.proxy gives the worker a callable handle into the main
    // thread; without the wrap it'd try to clone the function and throw.
    return await layout.run(init, onProgress ? Comlink.proxy(onProgress) : null);
  } finally {
    worker.terminate();
  }
}

async function runAnalysis(
  graph: LoadedGraph,
  resolution: number,
  clusterByLabel: boolean,
): Promise<Analysis> {
  // Label-based clustering is cheap (pure string ops) and doesn't need the
  // worker. Louvain is the slow path, so it's the only one that goes async.
  const communities = clusterByLabel
    ? clusterByLabelPrefix(graph)
    : await runAnalyze(graph, resolution);
  const radii = computeRadii(graph.inDegree, graph.outDegree);
  const seen = new Set<number>();

  for (let i = 0; i < communities.length; i++) seen.add(communities[i]!);

  return {
    graph,
    communities,
    communityCount: seen.size,
    radii,
  };
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
