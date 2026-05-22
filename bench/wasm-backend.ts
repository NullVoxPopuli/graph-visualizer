/**
 * Bench-side loader for the Rust/WASM layout backend.
 *
 * `pnpm build:wasm` emits a Node target into
 * `crates/layout-wasm/pkg-node` (alongside the `--target web` build the
 * app worker uses). This module dynamically imports that package; if it
 * isn't built yet it resolves to `null` so the benchmark can still report
 * the JS baseline on its own.
 */
import type { LayoutInit } from "../app/lib/layout-types.ts";

export interface WasmLayout {
  run(init: LayoutInit): Float32Array;
}

interface WasmModule {
  run_layout(
    nodeCount: number,
    edges: Int32Array,
    communities: Int32Array,
    radii: Float32Array,
    spreadFactor: number,
    repulsion: number,
    nodeDistance: number,
    clusterDistance: number,
    cohesion: number,
    progress: ((tick: number, total: number) => void) | undefined,
  ): Float32Array;
}

export async function loadWasmLayout(): Promise<WasmLayout | null> {
  try {
    // Path is intentionally a runtime string so bundlers/type-checkers
    // don't choke when the (generated, gitignored) package is absent.
    const spec = new URL("../crates/layout-wasm/pkg-node/layout_wasm.js", import.meta.url).href;
    const ns = (await import(spec)) as WasmModule & { default?: WasmModule };
    // The `--target nodejs` build is CommonJS; depending on Node's
    // cjs-named-export detection the functions land either directly on the
    // namespace or under `default`.
    const mod: WasmModule = typeof ns.run_layout === "function" ? ns : (ns.default as WasmModule);

    return {
      run(init: LayoutInit): Float32Array {
        return mod.run_layout(
          init.nodeCount,
          init.edges,
          init.communities,
          init.radii,
          init.spreadFactor,
          init.repulsion,
          init.nodeDistance,
          init.clusterDistance,
          init.cohesion,
          undefined,
        );
      },
    };
  } catch {
    return null;
  }
}
