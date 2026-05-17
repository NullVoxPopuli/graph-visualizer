/// <reference lib="webworker" />
import * as Comlink from "comlink";

import { type LayoutInit, type LayoutProgress, runLayoutCore } from "#lib/layout-core";

// Re-exported so existing importers (`#services/visualizer`) keep their
// `import type { LayoutEngine, LayoutInit } from "#lib/layout.worker"`
// path working after the simulation moved into `layout-core`.
export type { LayoutInit, LayoutProgress } from "#lib/layout-core";

const layoutEngine = {
  /**
   * Run the force-directed simulation to completion and return the final
   * positions buffer. Yields to the macrotask queue between batches so a
   * pending `terminate()` and the progress callback can land mid-run.
   */
  async run(init: LayoutInit, onProgress: LayoutProgress | null = null): Promise<Float32Array> {
    return runLayoutCore(init, { onProgress, yieldBetweenBatches: true });
  },
};

export type LayoutEngine = typeof layoutEngine;

Comlink.expose(layoutEngine);
