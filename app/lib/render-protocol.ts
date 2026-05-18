/**
 * The wire contract between the main thread (`render-proxy`) and the
 * render worker (`render.worker`). They talk over raw `postMessage`
 * (not Comlink) — a high-frequency one-way buffer stream where
 * proxy/promise overhead per frame would be wasteful — so nothing
 * structurally enforces the two halves agree. Defining the message
 * union + buffer strides *once*, imported by both, makes a drift
 * (renamed discriminant, changed field, wrong stride) a compile error
 * instead of a silent runtime corruption.
 */

/**
 * Floats per item for each uploadable buffer kind. The proxy slices the
 * caller's scratch array to `count * STRIDE[kind]` before transferring;
 * `pack.ts` packs to exactly this layout; `renderer.ts`'s GL vertex
 * strides are these ×4 bytes (its `vertexAttribPointer` offsets are the
 * interleaved attribute layout *within* that stride). Single source so
 * all three can't disagree.
 */
export const STRIDE = {
  nodes: 8, // (x,y,r, r,g,b,a, flags) per instance
  lines: 6, // (x,y, r,g,b,a) per vertex
  cycle: 6, // same layout as lines
  hulls: 6, // same layout as lines
  arrows: 9, // (sx,sy,tx,ty, r,g,b,a, srcRadius) per instance
} as const;

export type UploadKind = keyof typeof STRIDE;

/**
 * Main → worker. The proxy constructs these (type-checked, no hand-
 * rolled literals); the worker exhaustively switches on `t`.
 */
export type RenderInMsg =
  | { t: "init"; canvas: OffscreenCanvas; cssW: number; cssH: number; dpr: number }
  | { t: "resize"; cssW: number; cssH: number; dpr: number }
  | { t: "camera"; x: number; y: number; zoom: number }
  | { t: "edgeLod"; worldLen: number }
  | { t: "show"; hulls: boolean; arrows: boolean }
  | { t: "selected"; v: boolean }
  | { t: "upload"; kind: UploadKind; buffer: ArrayBuffer; count: number }
  | { t: "dirty" }
  // Cadence pulse from the main thread's rAF (vsync-aligned — fires at
  // the real display refresh, 240Hz on a 240Hz panel). Replaces the old
  // fixed-60 setTimeout self-loop so frame rate tracks the display.
  | { t: "tick" };

/** Worker → main. Posted once per real draw so the main thread can
 *  show the true rendered-frames-per-second. */
export type RenderOutMsg = { t: "frame" };
