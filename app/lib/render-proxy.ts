/**
 * Main-thread stand-in for `Renderer`. Exposes the exact subset of the
 * renderer API the visualizer component uses, but forwards everything to
 * the render worker (which owns the `OffscreenCanvas`, GL, and the draw
 * loop). Keeping the method shape identical means the component's
 * `repack*` code calls `this.renderer.uploadLines(...)` etc. unchanged.
 *
 * Vertex buffers are sliced to the used length and transferred (zero-
 * copy) — the slice is a fresh buffer, so the caller's scratch array is
 * never detached.
 */
const STRIDE = {
  nodes: 8, // (x,y,r, r,g,b,a, flags) per instance
  lines: 6, // (x,y, r,g,b,a) per vertex
  cycle: 6,
  hulls: 6,
  arrows: 9, // (sx,sy,tx,ty, r,g,b,a, srcRadius) per instance
} as const;

type Kind = keyof typeof STRIDE;

export class RenderProxy {
  #worker: Worker;
  #showHulls = false;
  #showArrows = true;

  constructor(worker: Worker) {
    this.#worker = worker;
  }

  #upload(kind: Kind, data: Float32Array, count: number): void {
    const used = Math.max(0, count) * STRIDE[kind];
    const slice = data.subarray(0, used).slice(); // fresh, transferable

    this.#worker.postMessage({ t: "upload", kind, buffer: slice.buffer, count }, [slice.buffer]);
  }

  uploadNodeInstances(data: Float32Array, count: number): void {
    this.#upload("nodes", data, count);
  }
  uploadLines(data: Float32Array, vertexCount: number): void {
    this.#upload("lines", data, vertexCount);
  }
  uploadCycleEdges(data: Float32Array, vertexCount: number): void {
    this.#upload("cycle", data, vertexCount);
  }
  uploadHulls(data: Float32Array, vertexCount: number): void {
    this.#upload("hulls", data, vertexCount);
  }
  uploadArrows(data: Float32Array, count: number): void {
    this.#upload("arrows", data, count);
  }

  setCamera(x: number, y: number, zoom: number): void {
    this.#worker.postMessage({ t: "camera", x, y, zoom });
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.#worker.postMessage({ t: "resize", cssW: cssWidth, cssH: cssHeight, dpr });
  }

  setShowHulls(v: boolean): void {
    this.#showHulls = v;
    this.#worker.postMessage({ t: "show", hulls: this.#showHulls, arrows: this.#showArrows });
  }
  setShowArrows(v: boolean): void {
    this.#showArrows = v;
    this.#worker.postMessage({ t: "show", hulls: this.#showHulls, arrows: this.#showArrows });
  }

  /** The worker owns the draw loop; nudge it that something changed. */
  markDirty(): void {
    this.#worker.postMessage({ t: "dirty" });
  }

  /** Keep the worker animating the selection halo (or not). */
  setSelected(v: boolean): void {
    this.#worker.postMessage({ t: "selected", v });
  }
}
