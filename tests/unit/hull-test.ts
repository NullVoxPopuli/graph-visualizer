import { module, test } from "qunit";

import { convexHull, inflate, triangulateFan } from "#lib/hull";

module("Unit | lib/hull | convexHull", () => {
  test("returns null for fewer than 3 points", (assert) => {
    assert.strictEqual(convexHull([]), null);
    assert.strictEqual(convexHull([[0, 0]]), null);
    assert.strictEqual(
      convexHull([
        [0, 0],
        [1, 1],
      ]),
      null,
    );
  });

  test("3 points return a 3-vertex hull", (assert) => {
    const hull = convexHull([
      [0, 0],
      [10, 0],
      [5, 10],
    ]);

    assert.strictEqual(hull?.length, 3);
  });

  test("interior point is dropped from the hull (a square with a center)", (assert) => {
    const hull = convexHull([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [5, 5], // interior — not on hull
    ]);

    assert.strictEqual(hull?.length, 4, "the four corners only");

    // Center point isn't among the hull's vertices.
    const includesCenter = (hull ?? []).some(([x, y]) => x === 5 && y === 5);

    assert.false(includesCenter);
  });
});

module("Unit | lib/hull | inflate", () => {
  test("zero pad is a passthrough", (assert) => {
    const poly: [number, number][] = [
      [0, 0],
      [10, 0],
      [5, 10],
    ];
    const out = inflate(poly, 0);

    assert.deepEqual(out, poly);
  });

  test("pushes each vertex outward by `pad` along the centroid → vertex direction", (assert) => {
    // Equilateral-ish triangle centered at (5, 10/3).
    const poly: [number, number][] = [
      [0, 0],
      [10, 0],
      [5, 10],
    ];
    const pad = 2;
    const inflated = inflate(poly, pad);
    const cx = (0 + 10 + 5) / 3;
    const cy = (0 + 0 + 10) / 3;

    for (let i = 0; i < poly.length; i++) {
      const [ox, oy] = poly[i]!;
      const [nx, ny] = inflated[i]!;
      // Inflated vertex sits further from centroid than original.
      const origDist = Math.hypot(ox - cx, oy - cy);
      const newDist = Math.hypot(nx - cx, ny - cy);

      assert.true(
        Math.abs(newDist - origDist - pad) < 1e-5,
        `vertex ${i}: distance should have grown by ${pad} (was ${origDist}, now ${newDist})`,
      );
    }
  });

  test("returns plain coords when input has fewer than 3 vertices", (assert) => {
    const poly: [number, number][] = [
      [0, 0],
      [10, 0],
    ];

    assert.deepEqual(inflate(poly, 5), [
      [0, 0],
      [10, 0],
    ]);
  });
});

module("Unit | lib/hull | triangulateFan", () => {
  test("fewer than 3 vertices return an empty buffer", (assert) => {
    assert.strictEqual(triangulateFan([]).length, 0);
    assert.strictEqual(triangulateFan([[0, 0]]).length, 0);
    assert.strictEqual(
      triangulateFan([
        [0, 0],
        [1, 1],
      ]).length,
      0,
    );
  });

  test("triangle: one fan triangle, 6 floats", (assert) => {
    const out = triangulateFan([
      [0, 0],
      [10, 0],
      [5, 10],
    ]);

    assert.strictEqual(out.length, 6, "3 vertices × 2 floats = one triangle");
    assert.deepEqual(Array.from(out), [0, 0, 10, 0, 5, 10]);
  });

  test("quad: two fan triangles, 12 floats; all share vertex 0", (assert) => {
    // poly[0] = pivot. Triangles: (p0, p1, p2), (p0, p2, p3).
    const out = triangulateFan([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]);

    assert.strictEqual(out.length, 12, "(n-2) triangles × 6 floats = 12");
    // First triangle: p0, p1, p2
    assert.deepEqual(Array.from(out.slice(0, 6)), [0, 0, 10, 0, 10, 10]);
    // Second triangle: p0, p2, p3
    assert.deepEqual(Array.from(out.slice(6, 12)), [0, 0, 10, 10, 0, 10]);
  });

  test("N-vertex polygon produces (N-2) triangles", (assert) => {
    const poly: [number, number][] = [
      [0, 0],
      [4, 0],
      [6, 3],
      [3, 6],
      [-1, 4],
    ];
    const out = triangulateFan(poly);

    assert.strictEqual(out.length, (poly.length - 2) * 6);
  });
});
