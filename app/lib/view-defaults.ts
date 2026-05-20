import type { LoadedGraph } from "#lib/types";

/**
 * URL defaults applied when we navigate to `/view` after loading (or
 * restoring) a graph. Single source of truth for callers in
 * `routes/index.ts` and `services/graph-loader.ts` — anything that
 * depends on the freshly-loaded graph's shape goes here.
 *
 * Edges are expensive to draw for large graphs (each one is at least a
 * line in the static layer, and the count grows roughly with node count
 * for typical dependency graphs), so we default them off above
 * `EDGES_HIDDEN_NODE_THRESHOLD` nodes — the user can re-enable from the
 * controls panel.
 */
export const EDGES_HIDDEN_NODE_THRESHOLD = 1000;

export function viewQueryParamDefaults(graph: LoadedGraph): Record<string, string> {
  return graph.ids.length > EDGES_HIDDEN_NODE_THRESHOLD ? { edges: "0" } : {};
}
