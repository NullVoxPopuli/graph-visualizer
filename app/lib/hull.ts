import { polygonHull } from "d3-polygon";

/** 2D convex hull of `points`. Returns CCW vertices, or null if < 3 points. */
export function convexHull(
  points: readonly (readonly [number, number])[],
): [number, number][] | null {
  if (points.length < 3) return null;

  const copy: [number, number][] = points.map((p) => [p[0], p[1]]);

  return polygonHull(copy);
}

/** Push each vertex outward from the polygon centroid by `pad` world units. */
export function inflate(
  poly: readonly (readonly [number, number])[],
  pad: number,
): [number, number][] {
  if (poly.length < 3 || pad === 0) return poly.map((p) => [p[0], p[1]] as [number, number]);

  let cx = 0;
  let cy = 0;

  for (const p of poly) {
    cx += p[0];
    cy += p[1];
  }

  cx /= poly.length;
  cy /= poly.length;

  return poly.map((p) => {
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    const len = Math.hypot(dx, dy) || 1;

    return [p[0] + (dx / len) * pad, p[1] + (dy / len) * pad];
  });
}

/** Convex polygon → triangle fan, returned as a flat XY Float32Array for gl.TRIANGLES. */
export function triangulateFan(
  poly: readonly (readonly [number, number])[],
): Float32Array {
  if (poly.length < 3) return new Float32Array(0);

  const out = new Float32Array((poly.length - 2) * 6);
  let k = 0;
  const p0 = poly[0]!;

  for (let i = 1; i < poly.length - 1; i++) {
    const p1 = poly[i]!;
    const p2 = poly[i + 1]!;

    out[k++] = p0[0];
    out[k++] = p0[1];
    out[k++] = p1[0];
    out[k++] = p1[1];
    out[k++] = p2[0];
    out[k++] = p2[1];
  }

  return out;
}
