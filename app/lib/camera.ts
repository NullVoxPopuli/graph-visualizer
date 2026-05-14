/**
 * 2D orthographic camera, driven by d3-zoom.
 *
 * Public state read by the renderer's shaders:
 *   x, y        — world coords of the screen center
 *   zoom        — device-px per world-unit
 *   width/height — device-px canvas size
 *
 * d3-zoom is the input handler (mouse drag pan, wheel zoom, programmatic
 * `transform` calls). We convert its `(k, t.x, t.y)` CSS-pixel transform
 * into our (cx, cy, deviceZoom) and write into the public fields on every
 * change.
 */
import { select, type Selection } from "d3-selection";
import {
  type D3ZoomEvent,
  zoom as d3zoom,
  type ZoomBehavior,
  zoomIdentity,
  type ZoomTransform,
} from "d3-zoom";

export class Camera {
  x = 0;
  y = 0;
  zoom = 1;
  width = 1;
  height = 1;

  private behavior: ZoomBehavior<HTMLCanvasElement, unknown>;
  private selection: Selection<HTMLCanvasElement, unknown, null, undefined>;
  private listeners = new Set<(ev: D3ZoomEvent<HTMLCanvasElement, unknown>) => void>();
  private animFrame: number | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.selection = select(canvas);
    this.behavior = d3zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([1e-9, 1e6])
      .filter((event: Event) => {
        if (event.type === "dblclick") return false;

        const e = event as MouseEvent & WheelEvent;

        // Wheel without a modifier = trackpad two-finger drag (or plain
        // mouse wheel) — handled as pan below, not by d3-zoom. Wheel WITH
        // ctrl/meta (or pinch-zoom, which the browser also reports with
        // ctrlKey=true) stays on the zoom path.
        if (event.type === "wheel" && !e.ctrlKey && !e.metaKey) return false;
        if (e.ctrlKey && event.type !== "wheel") return false;
        if (event.type === "mousedown" && e.button !== 0 && e.button !== 1) return false;

        return true;
      });

    const fanout = (event: D3ZoomEvent<HTMLCanvasElement, unknown>): void => {
      if (event.type === "zoom") this.applyTransform(event.transform);
      for (const fn of this.listeners) fn(event);
    };

    this.behavior.on("start", fanout);
    this.behavior.on("zoom", fanout);
    this.behavior.on("end", fanout);
    this.selection.call(this.behavior);
    this.selection.on("dblclick.zoom", null);

    canvas.addEventListener("wheel", this.#onWheelPan, { passive: false });
  }

  // Trackpad two-finger drag (and plain mouse wheel) — translate the
  // d3-zoom transform by the wheel delta. We can't go through `translateBy`
  // because that expects pre-transform offsets; reach into the current
  // transform and shift `t.x`/`t.y` by the delta directly.
  #onWheelPan = (ev: WheelEvent): void => {
    if (ev.ctrlKey || ev.metaKey) return;
    ev.preventDefault();

    const t = this.currentTransform();
    // deltaMode 0 = pixels, 1 = lines (~16px), 2 = pages (~viewport).
    const scale = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? this.height / this.dpr() : 1;
    const shifted = t.translate(-ev.deltaX * scale / t.k, -ev.deltaY * scale / t.k);

    this.behavior.transform(this.selection, shifted);
  };

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.applyTransform(this.currentTransform());
  }

  onChange(fn: (ev: D3ZoomEvent<HTMLCanvasElement, unknown>) => void): () => void {
    this.listeners.add(fn);

    return () => {
      this.listeners.delete(fn);
    };
  }

  screenToWorld(sx: number, sy: number): [number, number] {
    return [
      (sx - this.width / 2) / this.zoom + this.x,
      (sy - this.height / 2) / this.zoom + this.y,
    ];
  }

  fit(minX: number, minY: number, maxX: number, maxY: number, pad = 0.08): void {
    const w = Math.max(1e-6, maxX - minX);
    const h = Math.max(1e-6, maxY - minY);
    const zx = this.width / (w * (1 + pad));
    const zy = this.height / (h * (1 + pad));
    const z = Math.min(zx, zy);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    this.setView(cx, cy, z);
  }

  setView(cx: number, cy: number, deviceZoom: number): void {
    this.cancelAnim();
    this.behavior.transform(this.selection, this.transformFor(cx, cy, deviceZoom));
  }

  /**
   * Smoothly interpolate to (cx, cy, deviceZoom) over `durationMs`. Zoom is
   * interpolated in log space so the animation feels even across orders of
   * magnitude. Cancels any in-flight animation; calling `setView` (or user
   * drag/zoom) cancels too.
   */
  animateTo(cx: number, cy: number, deviceZoom: number, durationMs = 350): void {
    this.cancelAnim();

    const fromX = this.x;
    const fromY = this.y;
    const fromZoomLog = Math.log(this.zoom);
    const toZoomLog = Math.log(deviceZoom);
    const t0 = performance.now();
    const tick = (): void => {
      const u = Math.min(1, (performance.now() - t0) / durationMs);
      const e = 1 - Math.pow(1 - u, 3);
      const cxNow = fromX + (cx - fromX) * e;
      const cyNow = fromY + (cy - fromY) * e;
      const zNow = Math.exp(fromZoomLog + (toZoomLog - fromZoomLog) * e);

      this.behavior.transform(this.selection, this.transformFor(cxNow, cyNow, zNow));
      if (u < 1) {
        this.animFrame = requestAnimationFrame(tick);
      } else {
        this.animFrame = null;
      }
    };

    this.animFrame = requestAnimationFrame(tick);
  }

  /** True if (x, y) is inside the visible world rect, with optional margin (0..1). */
  worldPointInView(x: number, y: number, margin = 0.85): boolean {
    const halfW = (this.width / 2 / this.zoom) * margin;
    const halfH = (this.height / 2 / this.zoom) * margin;

    return Math.abs(x - this.x) <= halfW && Math.abs(y - this.y) <= halfH;
  }

  cancelAnim(): void {
    if (this.animFrame !== null) {
      cancelAnimationFrame(this.animFrame);
      this.animFrame = null;
    }
  }

  destroy(): void {
    this.cancelAnim();
    this.selection.on(".zoom", null);
    this.selection.node()?.removeEventListener("wheel", this.#onWheelPan);
    this.listeners.clear();
  }

  private dpr(): number {
    return window.devicePixelRatio || 1;
  }

  private currentTransform(): ZoomTransform {
    return this.transformFor(this.x, this.y, this.zoom);
  }

  /**
   * Convert centered (cx, cy, deviceZoom) → d3-zoom transform.
   * d3-zoom uses CSS-pixel input: screenCss = world * k + t.{x,y}.
   * We render with screenDev = world * deviceZoom + width/2 - cx*deviceZoom.
   * So k = deviceZoom / dpr; t.x = (width/dpr)/2 - cx * k.
   */
  private transformFor(cx: number, cy: number, deviceZoom: number): ZoomTransform {
    const dpr = this.dpr();
    const k = deviceZoom / dpr;
    const cssCenterX = this.width / 2 / dpr;
    const cssCenterY = this.height / 2 / dpr;

    return zoomIdentity.translate(cssCenterX - cx * k, cssCenterY - cy * k).scale(k);
  }

  private applyTransform(t: ZoomTransform): void {
    const dpr = this.dpr();
    const cssCenterX = this.width / 2 / dpr;
    const cssCenterY = this.height / 2 / dpr;

    this.zoom = t.k * dpr;
    this.x = (cssCenterX - t.x) / t.k;
    this.y = (cssCenterY - t.y) / t.k;
  }
}
