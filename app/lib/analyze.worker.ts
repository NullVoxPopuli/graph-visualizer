/// <reference lib="webworker" />
import * as Comlink from "comlink";
import Graph from "graphology";
import louvain from "graphology-communities-louvain";

export interface AnalyzeInit {
  nodeCount: number;
  /** flat (from, to, from, to, ...) edge pairs */
  edges: Int32Array;
}

export interface AnalyzeResult {
  /** community id per node, indexed 0..N-1 */
  communities: Int32Array;
  /** number of distinct communities */
  communityCount: number;
}

const analyzeEngine = {
  run({ nodeCount, edges }: AnalyzeInit): AnalyzeResult {
    const g = new Graph({ type: "directed", multi: false, allowSelfLoops: false });

    for (let i = 0; i < nodeCount; i++) g.addNode(i);

    for (let i = 0; i < edges.length; i += 2) {
      const a = edges[i]!;
      const b = edges[i + 1]!;

      if (a === b) continue;
      if (!g.hasEdge(a, b)) g.addEdge(a, b);
    }

    if (g.size === 0) {
      // No edges — every node is its own community.
      const comms = new Int32Array(nodeCount);

      for (let i = 0; i < nodeCount; i++) comms[i] = i;

      return { communities: comms, communityCount: nodeCount };
    }

    const assignments = louvain(g) as Record<string, number>;
    const communities = new Int32Array(nodeCount);
    const seen = new Set<number>();

    for (let i = 0; i < nodeCount; i++) {
      const c = assignments[String(i)] ?? 0;

      communities[i] = c;
      seen.add(c);
    }

    return { communities, communityCount: seen.size };
  },
};

export type AnalyzeEngine = typeof analyzeEngine;

Comlink.expose(analyzeEngine);
