/// <reference lib="webworker" />
import * as Comlink from "comlink";

import init, { run_layout } from "#lib/wasm/layout_wasm";

import type { LayoutInit, LayoutProgress } from "#lib/layout-core";

// Same public surface as `layout.worker.ts` so this is a drop-in: the
// service can swap which worker URL it spawns and nothing else changes.
export type { LayoutInit, LayoutProgress } from "#lib/layout-core";

// Instantiate the module once per worker. `init()` resolves
// `layout_wasm_bg.wasm` relative to this module — the bundler treats it as
// an asset.
let wasmReady: Promise<unknown> | null = null;

const layoutEngine = {
  /**
   * Run the Rust/WASM port of the d3-force pipeline. The simulation runs
   * to completion synchronously inside WASM (it can't cooperatively yield
   * the way the JS worker does between batches), so progress is reported
   * as a single 0→done transition. Cancellation still works: the service
   * `terminate()`s the whole worker, which kills the WASM run outright.
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
    );

    onProgress?.(1000, 1000);

    return positions;
  },
};

export type LayoutEngine = typeof layoutEngine;

Comlink.expose(layoutEngine);
