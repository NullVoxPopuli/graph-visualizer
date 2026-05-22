/**
 * Pure math for the panel-driven "focus on this node" camera move.
 *
 * Two jobs:
 *
 *   1) Pick a *stable* zoom level so repeat double-clicks settle on the
 *      same end state instead of compounding 1.5× per click into infinity.
 *      The target is `max(currentZoom, fitZoom * comfortMult)`: if the
 *      user is already zoomed in tighter than the "comfortable
 *      neighborhood" view, keep their zoom and just pan; otherwise pull
 *      them in to the comfort level.
 *
 *   2) If the destination is well off-screen, plan a two-phase animation
 *      via an intermediate "context view" wide enough to show both the
 *      current center and the target. The straight-line pan at constant
 *      zoom that `Camera.animateTo` does for a request just feels like a
 *      cut — you lose the spatial relationship between where you were and
 *      where you're going.
 */

export interface SceneBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface FocusPlanInput {
  /** Current camera center, world coords. */
  cx: number;
  cy: number;
  /** Current zoom: device-px per world-unit. */
  zoom: number;
  /** Canvas size, device px. Matches `Camera.width` / `Camera.height`. */
  viewportWidth: number;
  viewportHeight: number;
  /** Target node, world coords. */
  targetX: number;
  targetY: number;
  /** Scene extents in world coords. */
  bounds: SceneBounds;
  /**
   * How tight the "comfortable" view is, expressed as a multiplier on the
   * zoom that would fit the whole scene. 4 means "show about a quarter of
   * the graph"; 1 means "show all of it". Defaults to 4.
   */
  comfortMult?: number;
  /** Edge padding when sizing the via frame around two points. */
  pad?: number;
}

export interface FocusPlan {
  /** Final destination. */
  toCx: number;
  toCy: number;
  toZoom: number;
  /**
   * Intermediate waypoint, or `null` when a single-phase animation is
   * enough (target already on-screen, or moving in / unchanged zoom).
   */
  via: { cx: number; cy: number; zoom: number } | null;
}

const DEFAULT_COMFORT_MULT = 4;
const DEFAULT_PAD = 0.25;
const FIT_PAD = 0.08;

/**
 * Walk a packed `[x0, y0, x1, y1, …]` positions array and return the
 * bounding rect. Returns `null` if no finite point is present (empty
 * scene, all NaNs after a failed layout, etc.) so the caller can skip
 * the animation rather than animate to garbage.
 */
export function computeSceneBounds(positions: ArrayLike<number>): SceneBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let i = 0; i + 1 < positions.length; i += 2) {
    const x = positions[i];
    const y = positions[i + 1];

    if (x === undefined || y === undefined) continue;
    if (!isFinite(x) || !isFinite(y)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  if (!isFinite(minX)) return null;

  return { minX, minY, maxX, maxY };
}

/**
 * Zoom that would fit `bounds` in `viewportWidth × viewportHeight` with
 * `FIT_PAD` margin. Matches `Camera.fit`'s formula so the comfort
 * multiplier is calibrated against the same baseline the "reset view"
 * action lands on.
 */
export function fitZoomFor(
  bounds: SceneBounds,
  viewportWidth: number,
  viewportHeight: number,
): number {
  const w = Math.max(1e-6, bounds.maxX - bounds.minX);
  const h = Math.max(1e-6, bounds.maxY - bounds.minY);
  const zx = viewportWidth / (w * (1 + FIT_PAD));
  const zy = viewportHeight / (h * (1 + FIT_PAD));

  return Math.min(zx, zy);
}

/** True if the point sits inside the viewport at the given zoom, with a
 *  small margin (so we only count it "on screen" if it's not jammed
 *  against the edge). */
function pointInView(
  px: number,
  py: number,
  cx: number,
  cy: number,
  zoom: number,
  viewportWidth: number,
  viewportHeight: number,
  margin: number,
): boolean {
  const halfW = (viewportWidth / 2 / zoom) * margin;
  const halfH = (viewportHeight / 2 / zoom) * margin;

  return Math.abs(px - cx) <= halfW && Math.abs(py - cy) <= halfH;
}

/**
 * Largest zoom that frames both `(ax, ay)` and `(bx, by)` inside the
 * viewport with `pad` margin around the bounding pair.
 */
function zoomToFitPair(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  viewportWidth: number,
  viewportHeight: number,
  pad: number,
): number {
  const dx = Math.max(1e-6, Math.abs(bx - ax) * 2 * (1 + pad));
  const dy = Math.max(1e-6, Math.abs(by - ay) * 2 * (1 + pad));

  return Math.min(viewportWidth / dx, viewportHeight / dy);
}

/**
 * Decide where the camera should end up and whether the move needs an
 * intermediate "context" waypoint. See module doc-comment for the why.
 */
export function planFocusAnimation(input: FocusPlanInput): FocusPlan {
  const {
    cx,
    cy,
    zoom,
    viewportWidth,
    viewportHeight,
    targetX,
    targetY,
    bounds,
    comfortMult = DEFAULT_COMFORT_MULT,
    pad = DEFAULT_PAD,
  } = input;

  const fit = fitZoomFor(bounds, viewportWidth, viewportHeight);
  const comfort = fit * comfortMult;
  // If the user is already pulled in past the comfort level, leave them
  // there — a dblclick should not yank them back out. If they're zoomed
  // out, snap to the comfort level. Either way the result is stable: the
  // second dblclick on the same node lands on the same zoom as the first.
  const toZoom = Math.max(zoom, comfort);

  const onScreen = pointInView(targetX, targetY, cx, cy, zoom, viewportWidth, viewportHeight, 0.85);

  if (onScreen) {
    return { toCx: targetX, toCy: targetY, toZoom, via: null };
  }

  // Frame both points (current center + target) at the via waypoint.
  // Clamp the via zoom to be no tighter than the current zoom — there's
  // no point pretending to "zoom out for context" while actually zooming
  // in — and no wider than `fit` itself, so we never blow past the whole
  // scene during the transition.
  const fitBoth = zoomToFitPair(cx, cy, targetX, targetY, viewportWidth, viewportHeight, pad);
  const viaZoom = Math.min(zoom, Math.max(fit, fitBoth));

  // If the via zoom matches what we'd animate to anyway (e.g., the
  // points already fit at the current zoom from the midpoint), drop the
  // waypoint — `animateTo` will get us there in one smooth ramp.
  if (viaZoom >= zoom - 1e-6) {
    return { toCx: targetX, toCy: targetY, toZoom, via: null };
  }

  const viaCx = (cx + targetX) / 2;
  const viaCy = (cy + targetY) / 2;

  return {
    toCx: targetX,
    toCy: targetY,
    toZoom,
    via: { cx: viaCx, cy: viaCy, zoom: viaZoom },
  };
}
