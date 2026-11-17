/// <reference lib="webworker" />
import * as Comlink from "comlink";

import { packArrows, packEdges } from "#lib/pack";

/**
 * Off-main-thread vertex packing. The scene arrays are handed over once
 * per resolved scene (`setScene`); thereafter a selection/filter change
 * only sends a few scalars and gets back a *transferable* vertex buffer,
 * so "calculating which lines to draw" never blocks the main thread.
 *
 * Only the no-contraction fast path lives here (the visualizer keeps the
 * synchronous main-thread path for the `nodeRemap !== null` case, where
 * correctness needs the full scan — same split as `packEdges`). The
 * per-scene edge-incidence CSR is built here so the restricted pack is
 * O(degree), matching the main-thread implementation exactly (these call
 * the very same `packEdges`/`packArrows`).
 */
interface Scene {
  positions: Float32Array;
  edgesFlat: Int32Array;
  communities: Int32Array;
  edgeTypeIds: Int32Array;
  radii: Float32Array;
  incIdx: Int32Array;
  incEdges: Int32Array;
}

let scene: Scene | null = null;

function buildIncidence(
  edgesFlat: Int32Array,
  n: number,
): { incIdx: Int32Array; incEdges: Int32Array } {
  const E = edgesFlat.length / 2;
  const incIdx = new Int32Array(n + 1);

  for (let i = 0; i < E; i++) {
    incIdx[edgesFlat[2 * i]! + 1]!++;
    incIdx[edgesFlat[2 * i + 1]! + 1]!++;
  }

  for (let i = 0; i < n; i++) incIdx[i + 1]! += incIdx[i]!;

  const incEdges = new Int32Array(2 * E);
  const filled = new Int32Array(n);

  for (let i = 0; i < E; i++) {
    const a = edgesFlat[2 * i]!;
    const b = edgesFlat[2 * i + 1]!;

    incEdges[incIdx[a]! + filled[a]!] = i;
    filled[a]!++;
    incEdges[incIdx[b]! + filled[b]!] = i;
    filled[b]!++;
  }

  return { incIdx, incEdges };
}

const engine = {
  /**
   * Copies (not transfers) — the main thread still needs these arrays
   * for picking/dimming. One clone per resolved scene, off the per-click
   * path.
   */
  setScene(
    positions: Float32Array,
    edgesFlat: Int32Array,
    communities: Int32Array,
    edgeTypeIds: Int32Array,
    radii: Float32Array,
  ): void {
    const n = communities.length;
    const { incIdx, incEdges } = buildIncidence(edgesFlat, n);

    scene = { positions, edgesFlat, communities, edgeTypeIds, radii, incIdx, incEdges };
  },

  /** Update just the positions buffer (e.g. a relayout) without rebuilding the index. */
  setPositions(positions: Float32Array): void {
    if (scene) scene.positions = positions;
  },

  packEdges(
    hiddenTypeIds: number[],
    restrictToNode: number,
  ): { buffer: ArrayBuffer; vertexCount: number } {
    if (!scene) return { buffer: new ArrayBuffer(0), vertexCount: 0 };

    const hidden = hiddenTypeIds.length ? new Set(hiddenTypeIds) : null;
    const restrictEdges =
      restrictToNode >= 0
        ? scene.incEdges.subarray(scene.incIdx[restrictToNode], scene.incIdx[restrictToNode + 1])
        : null;
    const { buffer, vertexCount } = packEdges(
      scene.edgesFlat,
      scene.positions,
      scene.communities,
      scene.edgeTypeIds,
      hidden,
      null,
      restrictToNode,
      restrictEdges,
    );

    // Hand the vertex data to the main thread zero-copy.
    const raw = buffer.buffer as ArrayBuffer;

    return Comlink.transfer({ buffer: raw, vertexCount }, [raw]);
  },

  packArrows(
    hiddenTypeIds: number[],
    restrictToNode: number,
  ): { buffer: ArrayBuffer; count: number } {
    if (!scene) return { buffer: new ArrayBuffer(0), count: 0 };

    const hidden = hiddenTypeIds.length ? new Set(hiddenTypeIds) : null;
    const restrictEdges =
      restrictToNode >= 0
        ? scene.incEdges.subarray(scene.incIdx[restrictToNode], scene.incIdx[restrictToNode + 1])
        : null;
    const { buffer, count } = packArrows(
      scene.edgesFlat,
      scene.positions,
      scene.radii,
      scene.communities,
      scene.edgeTypeIds,
      hidden,
      null,
      restrictToNode,
      restrictEdges,
    );

    const raw = buffer.buffer as ArrayBuffer;

    return Comlink.transfer({ buffer: raw, count }, [raw]);
  },
};

export type RenderPackEngine = typeof engine;

Comlink.expose(engine);
