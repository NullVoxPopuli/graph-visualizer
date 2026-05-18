/// <reference lib="webworker" />
import * as Comlink from "comlink";

import init, { run_layout } from "#lib/wasm/layout_wasm";

import type { LayoutInit, LayoutProgress } from "#lib/layout-types";

// Re-exported so the visualizer service can import the engine type and
// its input contract from a single module.
export type { LayoutInit, LayoutProgress } from "#lib/layout-types";

// Instantiate the module once per worker. `init()` resolves
// `layout_wasm_bg.wasm` relative to this module — the bundler treats it as
// an asset.
let wasmReady: Promise<unknown> | null = null;

const layoutEngine = {
  /**
   * Run the Rust/WASM force-directed layout. WASM can't cooperatively
   * yield mid-run, but it calls `progress` once per batch so the progress
   * bar still advances during the (multi-second on big graphs) layout.
   * Uses the `fast` approximation schedule — steeper alpha decay + single
   * collide pass — for a large speedup at a small, measured layout
   * difference. Cancellation still works: the service `terminate()`s the
   * whole worker, killing the WASM run outright.
   */
  async run(
    layoutInit: LayoutInit,
    onProgress: LayoutProgress | null = null,
  ): Promise<Float32Array> {
    if (!wasmReady) {
      wasmReady = init({
        module_or_path: new URL("./wasm/layout_wasm_bg.wasm", import.meta.url),
      });
    }

    await wasmReady;

    onProgress?.(0, 1000);

    const positions = run_layout(
      layoutInit.nodeCount,
      layoutInit.edges,
      layoutInit.communities,
      layoutInit.radii,
      layoutInit.spreadFactor,
      layoutInit.repulsion,
      layoutInit.nodeDistance,
      layoutInit.clusterDistance,
      layoutInit.cohesion,
      onProgress ? (tick: number, total: number) => onProgress(tick, total) : undefined,
    );

    onProgress?.(1000, 1000);

    return positions;
  },
};

export type LayoutEngine = typeof layoutEngine;

Comlink.expose(layoutEngine);
