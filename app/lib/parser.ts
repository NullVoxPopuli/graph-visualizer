import { type InputGraph, SchemaError, validate } from "./schema.ts";

import type { LoadedGraph } from "./types.ts";

/**
 * Parse the user's JSON text into the internal LoadedGraph form. Throws
 * SchemaError on malformed input. Edges that target an id missing from
 * the `nodes` list don't get dropped — instead a synthetic node is
 * created for each such id with `type === "missing"` and `label === id`,
 * and the edge wires up to it. Self-loops are dropped (force layouts
 * handle them poorly and they aren't visually useful), and duplicate
 * `(from, to)` pairs collapse (first one wins for edgeType assignment).
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

/** The node type assigned to auto-created placeholder nodes. Exposed as
 *  a constant so consumers (style, type-filter chips, tests) can refer
 *  to the same string without a magic literal. */
export const MISSING_NODE_TYPE = "missing";

function buildLoadedGraph(input: InputGraph): LoadedGraph {
  // Real-node count is the initial high-water mark; synthetic "missing"
  // nodes append after these. Using `let N` (not `const`) so the final
  // size lands in one place — the per-node arrays push as we go.
  const initialN = input.nodes.length;
  const ids: string[] = [];
  const labels: string[] = [];
  const metas: unknown[] = [];
  const idToIndex = new Map<string, number>();

  // Node-type interning mirrors edge-type interning. Index 0 is the empty
  // (untyped) name; nodes without a `type` field hash there.
  const nodeTypeNames: string[] = [""];
  const nodeTypeIndex = new Map<string, number>([["", 0]]);
  const internNodeType = (name: string): number => {
    const existing = nodeTypeIndex.get(name);

    if (existing !== undefined) return existing;

    const idx = nodeTypeNames.length;

    nodeTypeNames.push(name);
    nodeTypeIndex.set(name, idx);

    return idx;
  };
  const nodeTypeIdList: number[] = [];

  for (let i = 0; i < initialN; i++) {
    const n = input.nodes[i]!;
    const id = String(n.id);

    if (idToIndex.has(id)) {
      throw new SchemaError(`Duplicate node id: ${id}`);
    }

    idToIndex.set(id, i);
    ids.push(id);
    labels.push(n.label ?? id);
    metas.push(n.meta);
    nodeTypeIdList.push(internNodeType(n.type ?? ""));
  }

  // Pre-intern the `missing` type even if we don't end up using it — it
  // makes the type-filter UI render the chip consistently across loads
  // and keeps `nodeTypeNames`'s ordering predictable.
  const missingTypeId = internNodeType(MISSING_NODE_TYPE);

  // Synthesize a placeholder node for `id`. Same `idToIndex` slot every
  // call, so re-using a missing id across many edges doesn't duplicate
  // the synthetic node. The label intentionally equals the id — we have
  // no better display string for a node we never saw declared.
  const ensureNodeForMissingId = (id: string): number => {
    const existing = idToIndex.get(id);

    if (existing !== undefined) return existing;

    const idx = ids.length;

    idToIndex.set(id, idx);
    ids.push(id);
    labels.push(id);
    metas.push(undefined);
    nodeTypeIdList.push(missingTypeId);

    return idx;
  };

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

  // Build flat edges with dedup. Self-loops still drop (force layouts
  // handle them poorly), but unknown ids now spawn synthetic
  // `missing`-typed nodes and the edge wires up to them. Dedupe key uses
  // a string instead of a number because the final node count is no
  // longer known up-front; encoding `(from, to)` as `${from}|${to}`
  // costs a hair more per edge but stays correct for any size.
  const seen = new Set<string>();
  const flat: number[] = [];
  const edgeTypeIdList: number[] = [];
  let droppedSelf = 0;
  let createdMissing = 0;
  let edgesToMissing = 0;

  for (let i = 0; i < initialN; i++) {
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

      const before = ids.length;
      const j = ensureNodeForMissingId(tid);

      if (ids.length > before) createdMissing++;
      if (j >= initialN) edgesToMissing++;

      if (j === i) {
        droppedSelf++;
        continue;
      }

      const key = `${i}|${j}`;

      if (seen.has(key)) continue;
      seen.add(key);
      flat.push(i, j);
      edgeTypeIdList.push(internEdgeType(typeName));
    }
  }

  if (createdMissing > 0) {
    console.warn(
      `Created ${createdMissing} placeholder node(s) of type "${MISSING_NODE_TYPE}" for ${edgesToMissing} edge(s) referencing ids not in the input.`,
    );
  }

  if (droppedSelf > 0) {
    console.warn(`Dropped ${droppedSelf} self-loop edge(s).`);
  }

  const N = ids.length;
  const edgesFlat = Int32Array.from(flat);
  const edgeTypeIds = Int32Array.from(edgeTypeIdList);

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
    outDegree,
    inDegree,
    edgeTypeNames,
    edgeTypeIds,
    nodeTypeNames,
    nodeTypeIds: Int32Array.from(nodeTypeIdList),
  };
}
