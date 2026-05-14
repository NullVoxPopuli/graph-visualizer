import { communityColorInto } from "./colors.ts";

/**
 * Pack a node-instance Float32Array (8 floats / 32 bytes per node) directly
 * compatible with the renderer's instanced vertex layout:
 *   (x, y, radius_world, r, g, b, a, flags)
 *
 * `flags` is 0 by default, 1 for selected, 2 for hovered. The vertex shader
 * reads this to grow the node + draw a ring.
 *
 * Reuses `out` if it's large enough; otherwise allocates a new one. Returns
 * the (possibly reallocated) buffer.
 */
export function packNodes(
  positions: Float32Array,
  radii: Float32Array,
  communities: Int32Array,
  selected: number,
  hovered: number,
  dimMask: Uint8Array | null,
  out: Float32Array,
): Float32Array {
  const N = communities.length;
  const need = N * 8;

  if (out.length < need) out = new Float32Array(need);

  const color: [number, number, number] = [0, 0, 0];

  for (let i = 0; i < N; i++) {
    communityColorInto(communities[i]!, color);

    const base = i * 8;

    out[base] = positions[2 * i]!;
    out[base + 1] = positions[2 * i + 1]!;
    out[base + 2] = radii[i]!;
    out[base + 3] = color[0];
    out[base + 4] = color[1];
    out[base + 5] = color[2];

    const dimmed = dimMask !== null && dimMask[i] === 1;

    out[base + 6] = dimmed ? 0.15 : 1;

    let flags = 0;

    if (i === selected) flags = 1;
    else if (i === hovered) flags = 2;
    out[base + 7] = flags;
  }

  return out;
}

/**
 * Pack edge line vertices (6 floats per vertex, 2 vertices per edge):
 *   (x, y, r, g, b, a)
 * Per-edge alpha is community-cross-aware: edges crossing community
 * boundaries render slightly brighter (they're the topologically interesting
 * ones).
 *
 * When `edgeTypeIds` + `hiddenTypes` are both present, edges whose type id
 * sits in the hidden set are skipped — both endpoints are simply not
 * emitted, so the returned `vertexCount` reflects only the visible edges.
 */
export function packEdges(
  edgesFlat: Int32Array,
  positions: Float32Array,
  communities: Int32Array,
  out: Float32Array,
  edgeTypeIds: Int32Array | null = null,
  hiddenTypes: Set<number> | null = null,
): { buffer: Float32Array; vertexCount: number } {
  const E = edgesFlat.length / 2;
  const need = E * 12;

  if (out.length < need) out = new Float32Array(need);

  const filter = edgeTypeIds !== null && hiddenTypes !== null && hiddenTypes.size > 0;
  const color: [number, number, number] = [0, 0, 0];
  let k = 0;
  let drawn = 0;

  for (let i = 0; i < E; i++) {
    if (filter && hiddenTypes!.has(edgeTypeIds![i]!)) continue;

    const a = edgesFlat[2 * i]!;
    const b = edgesFlat[2 * i + 1]!;
    const ca = communities[a]!;
    const cb = communities[b]!;
    const cross = ca !== cb;

    communityColorInto(ca, color);

    const alpha = cross ? 0.22 : 0.12;

    out[k++] = positions[2 * a]!;
    out[k++] = positions[2 * a + 1]!;
    out[k++] = color[0];
    out[k++] = color[1];
    out[k++] = color[2];
    out[k++] = alpha;
    communityColorInto(cb, color);
    out[k++] = positions[2 * b]!;
    out[k++] = positions[2 * b + 1]!;
    out[k++] = color[0];
    out[k++] = color[1];
    out[k++] = color[2];
    out[k++] = alpha;
    drawn++;
  }

  return { buffer: out, vertexCount: drawn * 2 };
}

/**
 * Compute display radius for each node, based on the larger of in- and
 * out-degree. sqrt growth so high-degree hubs don't dominate.
 */
export function computeRadii(inDegree: Int32Array, outDegree: Int32Array): Float32Array {
  const N = inDegree.length;
  const radii = new Float32Array(N);

  for (let i = 0; i < N; i++) {
    const deg = Math.max(inDegree[i]!, outDegree[i]!);

    radii[i] = Math.max(5, 2 + 1.6 * Math.sqrt(deg));
  }

  return radii;
}
