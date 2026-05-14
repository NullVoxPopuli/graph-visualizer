import Service, { service } from "@ember/service";
import { cached } from "@glimmer/tracking";
import * as Comlink from "comlink";
import { getPromiseState, type State } from "reactiveweb/get-promise-state";

import { computeRadii } from "#lib/pack";

import type { AnalyzeEngine, AnalyzeInit } from "#lib/analyze.worker";
import type { LayoutEngine, LayoutInit } from "#lib/layout.worker";
import type { LoadedGraph } from "#lib/types";
import type GraphService from "./graph";

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

  /**
   * The processing promise. Recomputed only when `graph.current` changes
   * (via `@cached`), so re-reads during a render hit the same promise and
   * `getPromiseState` cache.
   */
  @cached
  get processing(): Promise<ProcessedScene> | null {
    const g = this.graph.current;

    return g ? processGraph(g) : null;
  }

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
}

/**
 * Run the analyze worker on the given graph. The worker is spawned per call
 * and terminated as soon as the result is back — there's no long-lived
 * background work to manage.
 */
async function runAnalyze(graph: LoadedGraph): Promise<Int32Array> {
  const worker = new Worker(new URL("../lib/analyze.worker.ts", import.meta.url), {
    type: "module",
  });
  const analyze = Comlink.wrap<AnalyzeEngine>(worker);

  try {
    const init: AnalyzeInit = { nodeCount: graph.ids.length, edges: graph.edgesFlat };
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
async function runLayout(graph: LoadedGraph, communities: Int32Array): Promise<Float32Array> {
  const worker = new Worker(new URL("../lib/layout.worker.ts", import.meta.url), {
    type: "module",
  });
  const layout = Comlink.wrap<LayoutEngine>(worker);

  try {
    const init: LayoutInit = {
      nodeCount: graph.ids.length,
      edges: graph.edgesFlat,
      communities,
      spreadFactor: 1.2,
      repulsion: 6,
      springLength: 60,
      cohesion: 0.12,
    };

    return await layout.run(init);
  } finally {
    worker.terminate();
  }
}

async function processGraph(graph: LoadedGraph): Promise<ProcessedScene> {
  const communities = await runAnalyze(graph);
  const positions = await runLayout(graph, communities);
  const radii = computeRadii(graph.inDegree, graph.outDegree);
  const seen = new Set<number>();

  for (let i = 0; i < communities.length; i++) seen.add(communities[i]!);

  return {
    graph,
    positions,
    communities,
    communityCount: seen.size,
    radii,
  };
}
