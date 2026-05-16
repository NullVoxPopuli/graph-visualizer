import { modifier } from "ember-modifier";

/**
 * Geometry for a draggable / resizable floating panel. `null` for any
 * field means "fall back to the CSS default" — the URL params only
 * encode values the user has actually moved or resized away from default.
 */
export interface PanelGeometry {
  left: number | null;
  top: number | null;
  width: number | null;
  height: number | null;
}

interface DragOptions {
  /** CSS selector that matches the panel root (e.g. `.cycles-panel`). */
  panelSelector: string;
  /** Writes a new geometry to the URL (dedup / rAF-batch is the caller's job). */
  set: (g: PanelGeometry) => void;
}

/**
 * Title-bar drag modifier. Clicks on interactive descendants (buttons,
 * inputs, links) are left alone so they fire their own handlers — without
 * this the title bar's pointer-capture swallows the click. Pointer events
 * use the captured panel rect as the drag origin so the panel can switch
 * from `bottom`/`right` to `top`/`left` anchoring without a jump.
 *
 * The drag handler writes inline styles to the panel element **directly**
 * — geometry is no longer round-tripped through reactive state, so we
 * can't rely on a re-render to move the panel. The matching `set()` call
 * is what persists the URL for reloads / shared links.
 */
export function createDragModifier(opts: DragOptions) {
  return modifier((handle: HTMLElement) => {
    let dragging: {
      pointerId: number;
      startX: number;
      startY: number;
      panelLeft: number;
      panelTop: number;
      panelWidth: number;
      panelHeight: number;
    } | null = null;

    const panelEl = (): HTMLElement | null => handle.closest(opts.panelSelector);

    const onPointerDown = (ev: PointerEvent): void => {
      if (ev.button !== 0) return;

      const target = ev.target as HTMLElement | null;

      if (target && target.closest("button, input, a, select, textarea")) return;

      const panel = panelEl();

      if (!panel) return;

      const rect = panel.getBoundingClientRect();

      dragging = {
        pointerId: ev.pointerId,
        startX: ev.clientX,
        startY: ev.clientY,
        panelLeft: rect.left,
        panelTop: rect.top,
        panelWidth: rect.width,
        panelHeight: rect.height,
      };
      handle.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    };

    const onPointerMove = (ev: PointerEvent): void => {
      if (!dragging || ev.pointerId !== dragging.pointerId) return;

      const dx = ev.clientX - dragging.startX;
      const dy = ev.clientY - dragging.startY;
      const margin = 12;
      const left = clamp(
        dragging.panelLeft + dx,
        margin - dragging.panelWidth + 80,
        window.innerWidth - margin - 80,
      );
      const top = clamp(dragging.panelTop + dy, margin, window.innerHeight - margin - 24);

      const panel = panelEl();

      if (panel) {
        // Direct DOM write — no reactivity round-trip. Switching
        // `right`/`bottom` to `auto` matters because the CSS default
        // anchors some panels at `right: 12px` / `bottom: 12px`, and
        // leaving those set would fight the drag-supplied `left`/`top`.
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.right = "auto";
        panel.style.bottom = "auto";
      }

      opts.set({
        left,
        top,
        width: dragging.panelWidth,
        height: dragging.panelHeight,
      });
    };

    const onPointerUp = (ev: PointerEvent): void => {
      if (!dragging || ev.pointerId !== dragging.pointerId) return;
      handle.releasePointerCapture(dragging.pointerId);
      dragging = null;
    };

    handle.addEventListener("pointerdown", onPointerDown);
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", onPointerUp);
    handle.addEventListener("pointercancel", onPointerUp);

    return () => {
      handle.removeEventListener("pointerdown", onPointerDown);
      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointerup", onPointerUp);
      handle.removeEventListener("pointercancel", onPointerUp);
    };
  });
}

interface ApplyGeometryOptions {
  /** Reads the *initial* persisted geometry. Called once on mount. */
  getInitial: () => PanelGeometry | null;
  /**
   * Registers a callback that this modifier will run when the user
   * clicks "Recenter panels" (or any other path that asks all
   * floating panels to reset to their CSS defaults). Returns an
   * unregister function so the modifier can clean up on teardown.
   */
  registerReset: (cb: () => void) => () => void;
}

/**
 * Apply the persisted geometry as inline styles **once** at mount,
 * then step out of the way — drag and resize handlers update inline
 * styles directly, so we don't want a reactive re-apply running on
 * every drag tick. The only re-apply path left is "user asked to
 * recenter": that fires the registered reset callback, which clears
 * the inline styles back to "" so the CSS defaults take over.
 */
export function createApplyGeometryModifier(opts: ApplyGeometryOptions) {
  return modifier((el: HTMLElement) => {
    applyGeometryToElement(el, opts.getInitial());

    const unregister = opts.registerReset(() => {
      applyGeometryToElement(el, null);
    });

    return unregister;
  });
}

function applyGeometryToElement(el: HTMLElement, g: PanelGeometry | null): void {
  if (g === null) {
    el.style.left = "";
    el.style.top = "";
    el.style.right = "";
    el.style.bottom = "";
    el.style.width = "";
    el.style.height = "";

    return;
  }

  if (g.left !== null && g.top !== null) {
    el.style.left = `${g.left}px`;
    el.style.top = `${g.top}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
  }

  if (g.width !== null) el.style.width = `${g.width}px`;
  if (g.height !== null) el.style.height = `${g.height}px`;
}

interface SizeObserverOptions {
  /** Reads the currently persisted geometry — used only to dedupe identical writes. */
  getCurrent: () => PanelGeometry | null;
  /** Writes a new geometry to the URL. */
  set: (g: PanelGeometry) => void;
}

/**
 * ResizeObserver bridge: native `resize: both` lets the user grab the
 * bottom-right corner; the browser updates the DOM, and we just need
 * to mirror the resulting size to the URL so a reload restores it.
 * `getCurrent` is intentionally a non-tracked read of `#geometryRaw`,
 * so this modifier doesn't re-run on every URL write.
 */
export function createSizeObserverModifier(opts: SizeObserverOptions) {
  return modifier((el: HTMLElement) => {
    let lastW = 0;
    let lastH = 0;

    const obs = new ResizeObserver((entries) => {
      const entry = entries[0];

      if (!entry) return;

      const rect = el.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);

      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;

      const current = opts.getCurrent();
      const sameAsCurrent = current !== null && current.width === w && current.height === h;

      if (sameAsCurrent) return;

      opts.set({
        left: current?.left ?? rect.left,
        top: current?.top ?? rect.top,
        width: w,
        height: h,
      });
    });

    obs.observe(el);

    return () => obs.disconnect();
  });
}

function clamp(v: number, lo: number, hi: number): number {
  if (hi < lo) return lo;

  return v < lo ? lo : v > hi ? hi : v;
}
