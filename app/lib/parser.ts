import Graph from "graphology";

import { type InputGraph, SchemaError, validate } from "./schema.ts";

import type { LoadedGraph } from "./types.ts";

/**
 * Parse the user's JSON text into the internal LoadedGraph form. Throws
 * SchemaError on malformed input. Edges referencing unknown ids are dropped
 * with a console warning; duplicate (from, to) pairs are collapsed (first
 * one wins for edgeType assignment, since the underlying graphology is
 * non-multi).
 */
export function parseGraphJson(text: string): LoadedGraph {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new SchemaError(`Invalid JSON: ${(e as Error).message}`);
  }

  return buildLoadedGraph(validate(parsed));
}

function buildLoadedGraph(input: InputGraph): LoadedGraph {
  const N = input.nodes.length;
  const ids: string[] = new Array<string>(N);
  const labels: string[] = new Array<string>(N);
  const metas: unknown[] = new Array<unknown>(N);
  const idToIndex = new Map<string, number>();

  for (let i = 0; i < N; i++) {
    const n = input.nodes[i]!;
    const id = String(n.id);

    if (idToIndex.has(id)) {
      throw new SchemaError(`Duplicate node id: ${id}`);
    }

    idToIndex.set(id, i);
    ids[i] = id;
    labels[i] = n.label ?? id;
    metas[i] = n.meta;
  }

  // Edge-type interning. Index 0 is reserved for the empty (untyped) name —
  // bare-id edges hash there so the parallel `edgeTypeIds` array has the same
  // length as the edge list and never has gaps.
  const edgeTypeNames: string[] = [""];
  const edgeTypeIndex = new Map<string, number>([["", 0]]);
  const internEdgeType = (name: string): number => {
    const existing = edgeTypeIndex.get(name);

    if (existing !== undefined) return existing;

    const idx = edgeTypeNames.length;

    edgeTypeNames.push(name);
    edgeTypeIndex.set(name, idx);

    return idx;
  };

  // Build flat edges with dedup. Use a Set keyed by (from * N + to) to drop
  // duplicate pairs. Self-loops are dropped (force layouts handle them
  // poorly and they aren't visually useful).
  const seen = new Set<number>();
  const flat: number[] = [];
  const edgeTypeIdList: number[] = [];
  let droppedUnknown = 0;
  let droppedSelf = 0;

  for (let i = 0; i < N; i++) {
    const n = input.nodes[i]!;

    if (!n.edges) continue;

    for (const target of n.edges) {
      let tid: string;
      let typeName: string;

      if (typeof target === "string" || typeof target === "number") {
        tid = String(target);
        typeName = "";
      } else {
        tid = String(target.nodeId);
        typeName = target.edgeType;
      }

      const j = idToIndex.get(tid);

      if (j === undefined) {
        droppedUnknown++;
        continue;
      }

      if (j === i) {
        droppedSelf++;
        continue;
      }

      const key = i * N + j;

      if (seen.has(key)) continue;
      seen.add(key);
      flat.push(i, j);
      edgeTypeIdList.push(internEdgeType(typeName));
    }
  }

  if (droppedUnknown > 0) {
    console.warn(`Dropped ${droppedUnknown} edge(s) referencing unknown node ids.`);
  }

  if (droppedSelf > 0) {
    console.warn(`Dropped ${droppedSelf} self-loop edge(s).`);
  }

  const edgesFlat = Int32Array.from(flat);
  const edgeTypeIds = Int32Array.from(edgeTypeIdList);

  // Build graphology instance (used by Louvain in the analyze worker).
  const graph = new Graph({ type: "directed", multi: false, allowSelfLoops: false });

  for (let i = 0; i < N; i++) graph.addNode(i);

  for (let i = 0; i < edgesFlat.length; i += 2) {
    const a = edgesFlat[i]!;
    const b = edgesFlat[i + 1]!;

    graph.addEdge(a, b);
  }

  // Per-node degrees for sizing.
  const outDegree = new Int32Array(N);
  const inDegree = new Int32Array(N);

  for (let i = 0; i < edgesFlat.length; i += 2) {
    outDegree[edgesFlat[i]!]!++;
    inDegree[edgesFlat[i + 1]!]!++;
  }

  return {
    ids,
    labels,
    metas,
    idToIndex,
    edgesFlat,
    graph,
    outDegree,
    inDegree,
    edgeTypeNames,
    edgeTypeIds,
  };
}
