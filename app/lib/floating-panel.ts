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
    // Reset the inline cap overrides that drag/resize may have set
    // so the CSS-default `max-*` rules take over again.
    el.style.maxWidth = "";
    el.style.maxHeight = "";

    return;
  }

  if (g.left !== null && g.top !== null) {
    el.style.left = `${g.left}px`;
    el.style.top = `${g.top}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
  }

  // Inline `max-*: none` mirrors what the resize handles do during
  // an active drag: a saved size larger than the CSS `max-height` /
  // `max-width` would otherwise be clamped back down on remount,
  // silently undoing the user's last sizing choice.
  if (g.width !== null) {
    el.style.width = `${g.width}px`;
    el.style.maxWidth = "none";
  }

  if (g.height !== null) {
    el.style.height = `${g.height}px`;
    el.style.maxHeight = "none";
  }
}

/**
 * Which edge / corner a `createResizeModifier` handle drags. Compass
 * letters: `n` north (top), `s` south (bottom), `e` east (right), `w`
 * west (left); corners combine two letters. The presence of each
 * letter in the string flips on that side of the drag math.
 */
export type ResizeEdge = "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

interface ResizeOptions {
  /** CSS selector that matches the panel root (e.g. `.info-panel`). */
  panelSelector: string;
  edge: ResizeEdge;
  /** Writes the resized geometry to the URL. */
  set: (g: PanelGeometry) => void;
}

/**
 * Edge-based resize handle. Replaces the native `resize: both` corner
 * grab (which kept getting eaten by the inner scrollbar when the user
 * scrolled to the bottom and tried to grip the corner). Each panel
 * gets eight of these — one per edge and one per corner — positioned
 * just outside the panel border in CSS, so they never compete with
 * the inner element's scrollbar.
 *
 * Pointer events update the panel element's inline `width` /
 * `height` (and `left` / `top` for west/north drags) directly during
 * the drag so there's no reactive round-trip, and `set()` persists
 * the final geometry to the URL each frame.
 */
export function createResizeModifier(opts: ResizeOptions) {
  const hasW = opts.edge.includes("w");
  const hasE = opts.edge.includes("e");
  const hasN = opts.edge.includes("n");
  const hasS = opts.edge.includes("s");

  return modifier((handle: HTMLElement) => {
    let dragging: {
      pointerId: number;
      startX: number;
      startY: number;
      startWidth: number;
      startHeight: number;
      panelLeft: number;
      panelTop: number;
    } | null = null;

    const panelEl = (): HTMLElement | null => handle.closest(opts.panelSelector);

    const onPointerDown = (ev: PointerEvent): void => {
      if (ev.button !== 0) return;

      const panel = panelEl();

      if (!panel) return;

      const rect = panel.getBoundingClientRect();

      dragging = {
        pointerId: ev.pointerId,
        startX: ev.clientX,
        startY: ev.clientY,
        startWidth: rect.width,
        startHeight: rect.height,
        panelLeft: rect.left,
        panelTop: rect.top,
      };

      // Pin the panel to top-left anchoring before resizing — the
      // cycles-panel's CSS default is `left: 12px; bottom: 12px`, so
      // growing the height while `bottom` is fixed would push the top
      // edge *up*. Flipping to `top` / `left` matches the drag handler
      // and makes the resize math straightforward.
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";

      handle.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    };

    const onPointerMove = (ev: PointerEvent): void => {
      if (!dragging || ev.pointerId !== dragging.pointerId) return;

      const dx = ev.clientX - dragging.startX;
      const dy = ev.clientY - dragging.startY;
      const margin = 12;
      const minW = 200;
      const minH = 100;
      const panel = panelEl();

      if (!panel) return;

      let newWidth = dragging.startWidth;
      let newHeight = dragging.startHeight;
      let newLeft = dragging.panelLeft;
      let newTop = dragging.panelTop;

      if (hasE) {
        // East drag: right edge follows pointer, left edge stays put.
        newWidth = clamp(
          dragging.startWidth + dx,
          minW,
          window.innerWidth - dragging.panelLeft - margin,
        );
      } else if (hasW) {
        // West drag: left edge follows pointer, right edge stays put.
        // Width changes inversely with dx; left offsets by the
        // difference so the right edge stays anchored. Clamped so the
        // left edge can't cross either the viewport margin or the
        // panel's minimum width.
        const rightEdge = dragging.panelLeft + dragging.startWidth;
        const maxWidthFromMargin = rightEdge - margin;

        newWidth = clamp(dragging.startWidth - dx, minW, maxWidthFromMargin);
        newLeft = rightEdge - newWidth;
      }

      if (hasS) {
        newHeight = clamp(
          dragging.startHeight + dy,
          minH,
          window.innerHeight - dragging.panelTop - margin,
        );
      } else if (hasN) {
        const bottomEdge = dragging.panelTop + dragging.startHeight;
        const maxHeightFromMargin = bottomEdge - margin;

        newHeight = clamp(dragging.startHeight - dy, minH, maxHeightFromMargin);
        newTop = bottomEdge - newHeight;
      }

      panel.style.width = `${newWidth}px`;
      panel.style.height = `${newHeight}px`;
      // The panel's CSS `max-height` / `max-width` (e.g.
      // `min(96vh, max(50dvh, 500px))` on the info-panel) would
      // otherwise clamp the resize once the user drags past it.
      // Inline `none` here releases the cap so the resize handle
      // actually tracks the pointer past the CSS limit.
      panel.style.maxWidth = "none";
      panel.style.maxHeight = "none";

      if (hasW) panel.style.left = `${newLeft}px`;
      if (hasN) panel.style.top = `${newTop}px`;

      opts.set({
        left: newLeft,
        top: newTop,
        width: newWidth,
        height: newHeight,
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

function clamp(v: number, lo: number, hi: number): number {
  if (hi < lo) return lo;

  return v < lo ? lo : v > hi ? hi : v;
}
