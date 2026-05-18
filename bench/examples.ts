/**
 * Load the real example graphs (the ones shipped in `public/examples/`
 * and surfaced on the landing page) into `LayoutInit`s, replicating the
 * exact app pipeline: parse → Louvain community detection → degree-driven
 * radii. This makes the benchmark measure what users actually run,
 * including the 5k-node "large" example, instead of only the synthetic
 * generator.
 *
 * Louvain is reproduced here (not imported from `#lib/analyze.worker`,
 * which `Comlink.expose`s at module load and references the worker
 * global) — same shape as `analyzeEngine.run`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import Graph from "graphology";
import louvain from "graphology-communities-louvain";

import { EXAMPLES } from "#lib/examples";
import { computeRadii } from "#lib/pack";
import { parseGraphJson } from "#lib/parser";

import { DEFAULT_LAYOUT_PARAMS } from "./graph-gen.ts";

import type { LayoutInit } from "#lib/layout-types";

/** Mirror of `analyze.worker`'s Louvain run (resolution 1 = the default). */
function detectCommunities(nodeCount: number, edges: Int32Array): Int32Array {
  const g = new Graph({ type: "directed", multi: false, allowSelfLoops: false });

  for (let i = 0; i < nodeCount; i++) g.addNode(i);

  for (let i = 0; i < edges.length; i += 2) {
    const a = edges[i]!;
    const b = edges[i + 1]!;

    if (a === b) continue;
    if (!g.hasEdge(a, b)) g.addEdge(a, b);
  }

  const communities = new Int32Array(nodeCount);

  if (g.size === 0) {
    for (let i = 0; i < nodeCount; i++) communities[i] = i;

    return communities;
  }

  const assignments = louvain(g, { resolution: 1 }) as Record<string, number>;

  for (let i = 0; i < nodeCount; i++) communities[i] = assignments[String(i)] ?? 0;

  return communities;
}

export interface ExampleCase {
  label: string;
  init: LayoutInit;
}

/** Resolve a `/examples/x.json` manifest URL to its on-disk path. */
function examplePath(url: string): string {
  return fileURLToPath(new URL(`../public${url}`, import.meta.url));
}

export function loadExample(label: string, url: string): ExampleCase {
  const text = readFileSync(examplePath(url), "utf8");
  const graph = parseGraphJson(text);
  const nodeCount = graph.ids.length;
  const communities = detectCommunities(nodeCount, graph.edgesFlat);
  const radii = computeRadii(graph.inDegree, graph.outDegree);

  return {
    label,
    init: {
      nodeCount,
      edges: graph.edgesFlat,
      communities,
      radii,
      ...DEFAULT_LAYOUT_PARAMS,
    },
  };
}

/** Every shipped example, smallest-first, as benchmark cases. */
export function loadAllExamples(): ExampleCase[] {
  return EXAMPLES.map((e) => loadExample(e.label, e.url)).sort(
    (a, b) => a.init.nodeCount - b.init.nodeCount,
  );
}
