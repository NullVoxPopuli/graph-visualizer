/// <reference lib="webworker" />

/**
 * WebGL render worker. Owns the `OffscreenCanvas` + `Renderer` + the rAF
 * draw loop, so neither GL driver work, draw-call scheduling, nor the
 * selection-halo animation runs on (or is stalled by) the main thread.
 *
 * The main thread keeps input/camera/picking and the
 * pack/mask/contraction derivation; it streams packed vertex buffers
 * (transferable, zero-copy) + camera/flags here. Raw `postMessage`
 * (not Comlink) — this is a high-frequency one-way buffer stream where
 * proxy/promise overhead per frame would be wasteful.
 */
import { Renderer } from "#lib/renderer";

type UploadKind = "nodes" | "lines" | "arrows" | "hulls" | "cycle";

type InMsg =
  | { t: "init"; canvas: OffscreenCanvas; cssW: number; cssH: number; dpr: number }
  | { t: "resize"; cssW: number; cssH: number; dpr: number }
  | { t: "camera"; x: number; y: number; zoom: number }
  | { t: "show"; hulls: boolean; arrows: boolean }
  | { t: "selected"; v: boolean }
  | { t: "upload"; kind: UploadKind; buffer: ArrayBuffer; count: number }
  | { t: "dirty" };

let renderer: Renderer | null = null;
let dirty = true;
// Keep redrawing while a node is selected — the halo animates off
// `performance.now()` in the node shader and would otherwise freeze.
let selected = false;

// Dedicated workers have no requestAnimationFrame; self-schedule at
// ~60fps. The loop only issues GL when something changed (or while a
// node is selected, for the animated halo), so an idle graph costs a
// bare timer tick.
const FRAME_MS = 1000 / 60;

function frame(): void {
  setTimeout(frame, FRAME_MS);
  if (!renderer) return;

  if (dirty || selected) {
    renderer.draw();
    if (!selected) dirty = false;
  }
}

function upload(kind: UploadKind, buffer: ArrayBuffer, count: number): void {
  if (!renderer) return;

  const data = new Float32Array(buffer);

  switch (kind) {
    case "nodes":
      renderer.uploadNodeInstances(data, count);

      break;
    case "lines":
      renderer.uploadLines(data, count);

      break;
    case "arrows":
      renderer.uploadArrows(data, count);

      break;
    case "hulls":
      renderer.uploadHulls(data, count);

      break;
    case "cycle":
      renderer.uploadCycleEdges(data, count);

      break;
  }

  dirty = true;
}

self.onmessage = (e: MessageEvent<InMsg>): void => {
  const m = e.data;

  switch (m.t) {
    case "init":
      renderer = new Renderer(m.canvas);
      renderer.resize(m.cssW, m.cssH, m.dpr);
      dirty = true;
      frame();

      break;
    case "resize":
      renderer?.resize(m.cssW, m.cssH, m.dpr);
      dirty = true;

      break;
    case "camera":
      renderer?.setCamera(m.x, m.y, m.zoom);
      dirty = true;

      break;
    case "show":
      renderer?.setShowHulls(m.hulls);
      renderer?.setShowArrows(m.arrows);
      dirty = true;

      break;
    case "selected":
      selected = m.v;
      dirty = true;

      break;
    case "upload":
      upload(m.kind, m.buffer, m.count);

      break;
    case "dirty":
      dirty = true;

      break;
  }
};
