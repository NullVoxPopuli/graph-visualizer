/**
 * Deterministic palette indexable by community id, using the golden-angle
 * for hue spread. Cached in a flat Float32Array so per-edge lookups in the
 * pack hot path are three reads instead of HSL math.
 */
const GOLDEN = 137.508;

let cache = new Float32Array(0);
let computed = new Uint8Array(0);

function ensureCapacity(commId: number): void {
  const need = commId + 1;

  if (computed.length >= need) return;

  const grown = Math.max(need, computed.length * 2 || 64);
  const newCache = new Float32Array(grown * 3);
  const newComputed = new Uint8Array(grown);

  if (cache.length) newCache.set(cache);
  if (computed.length) newComputed.set(computed);
  cache = newCache;
  computed = newComputed;
}

function compute(commId: number): void {
  const hue = (((commId * GOLDEN) % 360) + 360) % 360;
  const sat = 0.85;
  const light = 0.66;
  const [r, g, b] = hslToRgb(hue, sat, light);
  const off = commId * 3;

  cache[off] = r;
  cache[off + 1] = g;
  cache[off + 2] = b;
  computed[commId] = 1;
}

export function communityColorInto(commId: number, out: [number, number, number]): void {
  ensureCapacity(commId);
  if (!computed[commId]) compute(commId);

  const off = commId * 3;

  out[0] = cache[off]!;
  out[1] = cache[off + 1]!;
  out[2] = cache[off + 2]!;
}

export function communityColor(commId: number): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];

  communityColorInto(commId, out);

  return out;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;

  if (hp < 1) {
    r = c;
    g = x;
  } else if (hp < 2) {
    r = x;
    g = c;
  } else if (hp < 3) {
    g = c;
    b = x;
  } else if (hp < 4) {
    g = x;
    b = c;
  } else if (hp < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  const m = l - c / 2;

  return [r + m, g + m, b + m];
}
