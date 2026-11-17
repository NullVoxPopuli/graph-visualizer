/**
 * Main-thread stand-in for `Renderer`. Exposes the exact subset of the
 * renderer API the visualizer component uses, but forwards everything to
 * the render worker (which owns the `OffscreenCanvas`, GL, and the draw
 * loop). Keeping the method shape identical means the component's
 * `repack*` code calls `this.renderer.uploadLines(...)` etc. unchanged.
 *
 * An upload transfers the buffer to the worker (zero-copy).
 * The caller's array is detached after the call, so pack into a new
 * array for each upload.
 */
import type { RenderInMsg, RenderOutMsg, UploadKind } from "#lib/render-protocol";

export class RenderProxy {
  #worker: Worker;
  #showHulls = false;
  #showArrows = true;
  /** Monotonic count of frames the worker reports actually drawn. The
   *  component samples the delta over time for the on-screen FPS. */
  framesRendered = 0;

  constructor(worker: Worker) {
    this.#worker = worker;
    this.#worker.addEventListener("message", (e: MessageEvent<RenderOutMsg>) => {
      if (e.data?.t === "frame") this.framesRendered++;
    });
  }

  /** Single typed send point — every message is checked against the
   *  shared `RenderInMsg` union, so the proxy can't drift from what the
   *  worker switches on. */
  #post(msg: RenderInMsg, transfer?: Transferable[]): void {
    this.#worker.postMessage(msg, transfer ?? []);
  }

  /** Hand the `OffscreenCanvas` to the worker (which then owns GL + the
   *  draw loop). Transfers the canvas. Call once, right after
   *  construction. */
  init(canvas: OffscreenCanvas, cssWidth: number, cssHeight: number, dpr: number): void {
    this.#post({ t: "init", canvas, cssW: cssWidth, cssH: cssHeight, dpr }, [canvas]);
  }

  /** Cadence pulse — call once per main-thread rAF; the worker draws
   *  this frame iff something changed (or a node is selected). */
  tick(): void {
    this.#post({ t: "tick" });
  }

  #upload(kind: UploadKind, data: Float32Array, count: number): void {
    /** The worker reads from the start of the buffer. */
    const whole = data.byteOffset === 0 ? data : data.slice();
    const buffer = whole.buffer as ArrayBuffer;

    this.#post({ t: "upload", kind, buffer, count }, [buffer]);
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
    this.#post({ t: "camera", x, y, zoom });
  }

  setEdgeLod(worldLen: number): void {
    this.#post({ t: "edgeLod", worldLen });
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.#post({ t: "resize", cssW: cssWidth, cssH: cssHeight, dpr });
  }

  setShowHulls(v: boolean): void {
    this.#showHulls = v;
    this.#post({ t: "show", hulls: this.#showHulls, arrows: this.#showArrows });
  }
  setShowArrows(v: boolean): void {
    this.#showArrows = v;
    this.#post({ t: "show", hulls: this.#showHulls, arrows: this.#showArrows });
  }

  /** The worker owns the draw loop; nudge it that something changed. */
  markDirty(): void {
    this.#post({ t: "dirty" });
  }

  /**
   * Node indices of the selected node and the hovered node, or -1.
   * The worker animates the selection halo while a node is selected.
   */
  setHighlight(selected: number, hovered: number): void {
    this.#post({ t: "highlight", selected, hovered });
  }
}
