import { parseGraphJson } from "#lib/parser";

import type { InputGraph } from "#lib/schema";
import type { LoadedGraph } from "#lib/types";

/**
 * Build a `LoadedGraph` from an inline JSON-shape object. Round-trips
 * through `parseGraphJson` so tests exercise the same code path the app
 * uses for user uploads — no hand-rolled `LoadedGraph` literals that
 * could quietly drift from the parser's invariants.
 *
 * `console.warn` is silenced during the parse so test output stays
 * clean for graphs that intentionally reference unknown ids or include
 * self-loops (both produce warnings in the parser).
 */
export function makeGraph(input: InputGraph): LoadedGraph {
  const originalWarn = console.warn;

  console.warn = (): void => {
    /* silence */
  };

  try {
    return parseGraphJson(JSON.stringify(input));
  } finally {
    console.warn = originalWarn;
  }
}

/**
 * Map node id → internal index. Convenience for assertions that need to
 * compare against `findAllCycles` output (which is indexed) without
 * sprinkling `graph.idToIndex.get(id)!` everywhere.
 */
export function indexOf(graph: LoadedGraph, id: string): number {
  const idx = graph.idToIndex.get(id);

  if (idx === undefined) throw new Error(`unknown id: ${id}`);

  return idx;
}

/**
 * Translate a cycle (`number[]`, internal indices) back to the user-
 * facing ids so assertions read naturally regardless of how the parser
 * happened to order the nodes.
 */
export function cycleToIds(graph: LoadedGraph, cycle: number[]): string[] {
  return cycle.map((i) => graph.ids[i]!);
}
