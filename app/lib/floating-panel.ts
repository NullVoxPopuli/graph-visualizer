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
  /** Returns the geometry currently committed to the URL, if any. */
  get: () => PanelGeometry | null;
  /** Writes a new geometry to the URL (dedup / rAF-batch is the caller's job). */
  set: (g: PanelGeometry) => void;
}

/**
 * Title-bar drag modifier. Clicks on interactive descendants (buttons,
 * inputs, links) are left alone so they fire their own handlers — without
 * this the title bar's pointer-capture swallows the click. Pointer events
 * use the captured panel rect as the drag origin so the panel can switch
 * from `bottom`/`right` to `top`/`left` anchoring without a jump.
 */
export function createDragModifier(opts: DragOptions): ReturnType<typeof modifier> {
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

    const panelEl = (): HTMLElement | null =>
      handle.closest(opts.panelSelector);

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

/**
 * Apply the persisted geometry as inline styles. ember-modifier auto-
 * tracks the `get()` read, so a URL update re-runs the modifier and
 * re-applies the styles. Clearing geometry resets the styles to "" so
 * the CSS defaults take over.
 */
export function createApplyGeometryModifier(
  get: () => PanelGeometry | null,
): ReturnType<typeof modifier> {
  return modifier((el: HTMLElement) => {
    const g = get();

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
  });
}

/**
 * ResizeObserver bridge: native `resize: both` lets the user grab the
 * bottom-right corner; we commit the resulting size (alongside the
 * current position) to the URL so a reload restores it.
 */
export function createSizeObserverModifier(
  get: () => PanelGeometry | null,
  set: (g: PanelGeometry) => void,
): ReturnType<typeof modifier> {
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

      const current = get();
      const sameAsCurrent = current !== null && current.width === w && current.height === h;

      if (sameAsCurrent) return;

      set({
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
