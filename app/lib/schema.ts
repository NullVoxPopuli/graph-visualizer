/**
 * The JSON schema users upload. Adjacency list: edges are listed on the
 * source node. Edges referencing unknown ids are dropped with a console
 * warning; duplicate (from, to) pairs are collapsed.
 *
 * An edge entry is either a bare id (string|number) or an object
 * `{ nodeId, edgeType }`. The two forms can be mixed freely in the same
 * `edges` array.
 *
 * Example:
 *   {
 *     "nodes": [
 *       {
 *         "id": "alpha",
 *         "label": "Alpha",
 *         "edges": ["beta", { "nodeId": "gamma", "edgeType": "calls" }]
 *       },
 *       { "id": "beta", "edges": ["gamma"] },
 *       { "id": "gamma" }
 *     ]
 *   }
 */
export interface InputEdgeObject {
  nodeId: string | number;
  edgeType: string;
}

export type InputEdge = string | number | InputEdgeObject;

export interface InputNode {
  id: string | number;
  label?: string;
  /**
   * Optional kind classifier — e.g. "package", "file", "class". Interned by
   * the parser into `nodeTypeNames` / `nodeTypeIds` on the LoadedGraph so
   * downstream code can filter and color by type without re-parsing.
   */
  type?: string;
  edges?: InputEdge[];
  meta?: unknown;
}

export interface InputGraph {
  nodes: InputNode[];
}

export class SchemaError extends Error {}

export function validate(input: unknown): InputGraph {
  if (input === null || typeof input !== "object") {
    throw new SchemaError("Expected an object with a `nodes` array at the top level.");
  }

  const obj = input as Record<string, unknown>;

  if (!Array.isArray(obj["nodes"])) {
    throw new SchemaError("Top-level `nodes` must be an array.");
  }

  const nodes = obj["nodes"] as unknown[];

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];

    if (n === null || typeof n !== "object") {
      throw new SchemaError(`nodes[${i}] is not an object.`);
    }

    const nn = n as Record<string, unknown>;

    if (nn["id"] === undefined || nn["id"] === null) {
      throw new SchemaError(`nodes[${i}].id is required.`);
    }

    if (typeof nn["id"] !== "string" && typeof nn["id"] !== "number") {
      throw new SchemaError(`nodes[${i}].id must be a string or number.`);
    }

    if (nn["label"] !== undefined && typeof nn["label"] !== "string") {
      throw new SchemaError(`nodes[${i}].label must be a string when present.`);
    }

    if (nn["type"] !== undefined && typeof nn["type"] !== "string") {
      throw new SchemaError(`nodes[${i}].type must be a string when present.`);
    }

    if (nn["edges"] !== undefined) {
      if (!Array.isArray(nn["edges"])) {
        throw new SchemaError(`nodes[${i}].edges must be an array when present.`);
      }

      const edgeArr = nn["edges"] as unknown[];

      for (let k = 0; k < edgeArr.length; k++) {
        const e = edgeArr[k];

        if (typeof e === "string" || typeof e === "number") continue;

        if (e !== null && typeof e === "object") {
          const eo = e as Record<string, unknown>;

          if (typeof eo["nodeId"] !== "string" && typeof eo["nodeId"] !== "number") {
            throw new SchemaError(
              `nodes[${i}].edges[${k}].nodeId must be a string or number.`,
            );
          }

          if (typeof eo["edgeType"] !== "string") {
            throw new SchemaError(
              `nodes[${i}].edges[${k}].edgeType must be a string.`,
            );
          }

          continue;
        }

        throw new SchemaError(
          `nodes[${i}].edges[${k}] must be a string, number, or { nodeId, edgeType } object.`,
        );
      }
    }
  }

  return obj as unknown as InputGraph;
}
