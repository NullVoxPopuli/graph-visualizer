/**
 * Shared shapes for the layout pipeline. The simulation itself lives in
 * Rust/WASM (`#lib/wasm/layout_wasm`, driven by `layout-wasm.worker`);
 * these types are the worker's input contract and progress hook, kept in
 * a dependency-free module so the worker, the visualizer service, and the
 * benchmarks can all share them without pulling in Comlink or the
 * `webworker` lib reference.
 */

export interface LayoutInit {
  nodeCount: number;
  edges: Int32Array;
  communities: Int32Array;
  /** Display radius per node (world units). Drives the collide force so
   *  bigger nodes carve out proportionally more space and don't overlap
   *  small ones. */
  radii: Float32Array;
  spreadFactor: number;
  repulsion: number;
  /** Equilibrium distance for edges that stay inside a single community. */
  nodeDistance: number;
  /** Equilibrium distance for edges that cross a community boundary. */
  clusterDistance: number;
  cohesion: number;
}

/**
 * Optional progress hook the worker calls between simulation batches. The
 * caller passes a `Comlink.proxy(...)`-wrapped function from the main
 * thread so each invocation marshals back through the worker boundary.
 * `null` is fine — no overhead when no listener cares.
 */
export type LayoutProgress = (tick: number, total: number) => void;
