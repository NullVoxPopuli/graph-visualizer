import { module, test } from "qunit";

import { computeRadii } from "#lib/pack";

module("Unit | lib/pack | computeRadii", () => {
  test("empty input returns an empty Float32Array", (assert) => {
    const radii = computeRadii(new Int32Array(0), new Int32Array(0));

    assert.strictEqual(radii.length, 0);
  });

  test("uses the larger of in- vs out-degree per node", (assert) => {
    // node 0: in=4, out=1 → max=4
    // node 1: in=0, out=9 → max=9
    // node 2: in=2, out=2 → max=2
    const radii = computeRadii(new Int32Array([4, 0, 2]), new Int32Array([1, 9, 2]));
    // Compare with tolerance because Float32Array loses precision vs.
    // the JS double-precision computation (5.2 → 5.199999809…).
    const eps = 1e-4;
    const radiusOf = (deg: number): number => Math.max(5, 2 + 1.6 * Math.sqrt(deg));

    assert.true(Math.abs(radii[0]! - radiusOf(4)) < eps, `node 0 ≈ ${radiusOf(4)}`);
    assert.true(Math.abs(radii[1]! - radiusOf(9)) < eps, `node 1 ≈ ${radiusOf(9)}`);
    assert.true(Math.abs(radii[2]! - radiusOf(2)) < eps, `node 2 ≈ ${radiusOf(2)}`);
  });

  test("clamps to a minimum of 5 for low-degree nodes", (assert) => {
    // deg=0 → 2 + 0 = 2 → clamped to 5
    // deg=1 → 2 + 1.6 = 3.6 → clamped to 5
    const radii = computeRadii(new Int32Array([0, 1]), new Int32Array([0, 0]));

    assert.strictEqual(radii[0], 5);
    assert.strictEqual(radii[1], 5);
  });

  test("scales with sqrt(deg) above the floor", (assert) => {
    // deg=100 → 2 + 1.6 * 10 = 18; deg=400 → 2 + 1.6 * 20 = 34.
    // Doubling sqrt(deg) (deg: 100 → 400) ≈ doubles the "growth"
    // portion (16 → 32), reflecting the sqrt growth curve.
    const radii = computeRadii(new Int32Array([100, 400]), new Int32Array([0, 0]));

    assert.true(Math.abs(radii[0]! - (2 + 1.6 * 10)) < 1e-5);
    assert.true(Math.abs(radii[1]! - (2 + 1.6 * 20)) < 1e-5);
    // Sanity: 4× the in-degree → ~2× the radius growth.
    assert.true(radii[1]! > radii[0]!);
  });
});
