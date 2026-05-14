import type Graph from "graphology";

/**
 * Parsed, in-memory representation of a graph loaded from the user's JSON.
 *
 * `ids`, `labels`, and `metas` are indexed by an internal numeric node index
 * (0..N-1). `idToIndex` maps the user's original id string to that index.
 * `edgesFlat` is a flat (from, to, from, to, ...) Int32Array — the form
 * d3-force and the layout worker want.
 *
 * Edge typing: the input schema lets each edge be a bare id or
 * `{ nodeId, edgeType }`. After parsing, every edge has an integer
 * `edgeTypeIds[i]` indexing into `edgeTypeNames`. Bare-id edges get
 * `edgeTypeIds[i] === 0`, which points at `edgeTypeNames[0] = ""` (untyped).
 */
export interface LoadedGraph {
  ids: string[];
  labels: string[];
  metas: unknown[];
  idToIndex: Map<string, number>;
  edgesFlat: Int32Array;
  graph: Graph;
  /** count of out-edges per node, for sizing */
  outDegree: Int32Array;
  /** count of in-edges per node, for sizing */
  inDegree: Int32Array;
  /** Distinct edge type names. Index 0 is always the empty string (untyped). */
  edgeTypeNames: string[];
  /** Edge type id per (collapsed) edge in `edgesFlat`. Length = edgesFlat.length / 2. */
  edgeTypeIds: Int32Array;
  /** Distinct node type names. Index 0 is always the empty string (untyped). */
  nodeTypeNames: string[];
  /** Node type id per node, indexed by node index. */
  nodeTypeIds: Int32Array;
}
