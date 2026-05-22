import { module, test } from "qunit";

import {
  computeSceneBounds,
  fitZoomFor,
  type FocusPlanInput,
  planFocusAnimation,
  type SceneBounds,
} from "#lib/focus-plan";

const BOUNDS: SceneBounds = { minX: -100, minY: -100, maxX: 100, maxY: 100 };
const VIEW = { viewportWidth: 1000, viewportHeight: 1000 };

function planAt(overrides: Partial<FocusPlanInput>): ReturnType<typeof planFocusAnimation> {
  return planFocusAnimation({
    cx: 0,
    cy: 0,
    zoom: 1,
    viewportWidth: VIEW.viewportWidth,
    viewportHeight: VIEW.viewportHeight,
    targetX: 0,
    targetY: 0,
    bounds: BOUNDS,
    ...overrides,
  });
}

module("Unit | lib/focus-plan | computeSceneBounds", () => {
  test("returns null on an empty buffer", (assert) => {
    assert.strictEqual(computeSceneBounds(new Float32Array(0)), null);
  });

  test("skips non-finite points (e.g., failed layout)", (assert) => {
    const out = computeSceneBounds([NaN, NaN, 1, 2, Infinity, 0, -3, -4]);

    assert.deepEqual(out, { minX: -3, minY: -4, maxX: 1, maxY: 2 });
  });

  test("returns null when every point is non-finite", (assert) => {
    assert.strictEqual(computeSceneBounds([NaN, NaN, Infinity, Infinity]), null);
  });

  test("computes the bounding rect across a packed [x, y, x, y, …] buffer", (assert) => {
    assert.deepEqual(computeSceneBounds([0, 0, 10, -5, -3, 8]), {
      minX: -3,
      minY: -5,
      maxX: 10,
      maxY: 8,
    });
  });
});

module("Unit | lib/focus-plan | planFocusAnimation | target zoom", () => {
  test("zoomed all the way out → snaps to comfort level (fit * 4)", (assert) => {
    const fit = fitZoomFor(BOUNDS, VIEW.viewportWidth, VIEW.viewportHeight);
    const plan = planAt({ zoom: fit });

    assert.ok(
      Math.abs(plan.toZoom - fit * 4) < 1e-6,
      `comfort target ≈ fit * 4 (got ${plan.toZoom}, expected ${fit * 4})`,
    );
  });

  test("already past the comfort zoom → keeps the user's zoom (no zoom-out)", (assert) => {
    const fit = fitZoomFor(BOUNDS, VIEW.viewportWidth, VIEW.viewportHeight);
    // User has wheeled in to 10× fit, way past comfort (4× fit).
    const plan = planAt({ zoom: fit * 10 });

    assert.strictEqual(plan.toZoom, fit * 10, "comfort floor does not pull the user back out");
  });

  test("repeat dblclicks at the comfort zoom are idempotent (no compounding)", (assert) => {
    const fit = fitZoomFor(BOUNDS, VIEW.viewportWidth, VIEW.viewportHeight);
    const first = planAt({ zoom: fit }).toZoom;
    // Pretend the camera now sits at the first plan's destination, and
    // re-plan from there. The end state must equal the first one — that
    // is what makes repeat-dblclicks stop "infinite zooming."
    const second = planAt({ zoom: first }).toZoom;

    assert.strictEqual(second, first, "second plan settles on the same zoom");
  });

  test("comfortMult is parameterizable", (assert) => {
    const fit = fitZoomFor(BOUNDS, VIEW.viewportWidth, VIEW.viewportHeight);
    const plan = planAt({ zoom: fit, comfortMult: 2 });

    assert.ok(Math.abs(plan.toZoom - fit * 2) < 1e-6, "honors a custom comfort multiplier");
  });
});

module("Unit | lib/focus-plan | planFocusAnimation | via waypoint", () => {
  test("target on-screen → no via waypoint (single-phase animation)", (assert) => {
    // Zoom fit + center on origin, target at (5, 5) — well inside the
    // 200-unit-wide scene at fit zoom.
    const fit = fitZoomFor(BOUNDS, VIEW.viewportWidth, VIEW.viewportHeight);
    const plan = planAt({ zoom: fit, targetX: 5, targetY: 5 });

    assert.strictEqual(plan.via, null, "no via waypoint when target is already on screen");
    assert.strictEqual(plan.toCx, 5);
    assert.strictEqual(plan.toCy, 5);
  });

  test("zoomed in + target off-screen → adds a via waypoint midway, zoomed out for context", (assert) => {
    const fit = fitZoomFor(BOUNDS, VIEW.viewportWidth, VIEW.viewportHeight);
    // 10× fit: only ~1/10 of the scene fits on screen. Target at (90, 0)
    // is far off the right edge when the camera centers on origin.
    const plan = planAt({ zoom: fit * 10, targetX: 90, targetY: 0 });

    assert.ok(plan.via, "off-screen target triggers a via waypoint");
    assert.strictEqual(plan.via?.cx, 45, "via center is the midpoint between source and target");
    assert.strictEqual(plan.via?.cy, 0);
    assert.ok(
      (plan.via?.zoom ?? Infinity) < fit * 10,
      "via zoom is wider than the current zoom (context view)",
    );
    assert.ok(
      (plan.via?.zoom ?? -Infinity) >= fit,
      "via zoom is not wider than the full-scene fit zoom",
    );
  });

  test("via zoom is wide enough to frame both source and target", (assert) => {
    const fit = fitZoomFor(BOUNDS, VIEW.viewportWidth, VIEW.viewportHeight);
    const plan = planAt({ zoom: fit * 10, targetX: 90, targetY: 0 });

    assert.ok(plan.via, "via present");

    // At via zoom and via center, both points must be inside the viewport.
    const viaZoom = plan.via?.zoom ?? 0;
    const viaCx = plan.via?.cx ?? 0;
    const viaCy = plan.via?.cy ?? 0;
    const halfW = VIEW.viewportWidth / 2 / viaZoom;
    const halfH = VIEW.viewportHeight / 2 / viaZoom;

    assert.ok(Math.abs(0 - viaCx) <= halfW, "source x within via viewport");
    assert.ok(Math.abs(0 - viaCy) <= halfH, "source y within via viewport");
    assert.ok(Math.abs(90 - viaCx) <= halfW, "target x within via viewport");
    assert.ok(Math.abs(0 - viaCy) <= halfH, "target y within via viewport");
  });

  test("destination at the via path's end is the target node + comfort zoom", (assert) => {
    const fit = fitZoomFor(BOUNDS, VIEW.viewportWidth, VIEW.viewportHeight);
    const plan = planAt({ zoom: fit * 10, targetX: 90, targetY: 0 });

    assert.strictEqual(plan.toCx, 90, "lands on target x");
    assert.strictEqual(plan.toCy, 0, "lands on target y");
    assert.strictEqual(plan.toZoom, fit * 10, "lands at the stable target zoom");
  });

  test("via skipped when current zoom already frames both points from the midpoint", (assert) => {
    const fit = fitZoomFor(BOUNDS, VIEW.viewportWidth, VIEW.viewportHeight);
    // At fit zoom, a target just past the 0.85 on-screen margin still
    // lives inside the actual viewport; once we re-center on the
    // midpoint, the current zoom is already wide enough to include both.
    // No need to dip out to a wider waypoint — `animateTo` with a zoom
    // ramp of zero is just a pan.
    const plan = planAt({ zoom: fit, targetX: 95, targetY: 0 });

    assert.strictEqual(
      plan.via,
      null,
      "no via when framing zoom is not strictly wider than current",
    );
  });
});
