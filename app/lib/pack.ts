import { communityColorInto } from "./colors.ts";

/**
 * Pack a node-instance Float32Array (8 floats / 32 bytes per node) directly
 * compatible with the renderer's instanced vertex layout:
 *   (x, y, radius_world, r, g, b, a, flags)
 *
 * `flags` is a small bitmask consumed by the vertex/fragment shader so
 * states compose freely:
 *   bit 0 (1) = selected     → animated dashed halo
 *   bit 1 (2) = hovered      → body grows
 *   bit 2 (4) = cycle member → red outline
 * (selected and hovered are still mutually exclusive at pack time —
 * selection wins — but selected + cycle can both be on for the chosen node.)
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
  hideMask: Uint8Array | null,
  cycleMask: Uint8Array | null,
  out: Float32Array,
): Float32Array {
  const N = communities.length;
  const need = N * 8;

  if (out.length < need) out = new Float32Array(need);

  const color: [number, number, number] = [0, 0, 0];

  for (let i = 0; i < N; i++) {
    communityColorInto(communities[i]!, color);

    const base = i * 8;
    const hidden = hideMask !== null && hideMask[i] === 1;

    out[base] = positions[2 * i]!;
    out[base + 1] = positions[2 * i + 1]!;
    // Zero-radius hidden nodes render invisibly (the fragment shader
    // discards them) but stay at the same instance index so the picker /
    // selection bookkeeping doesn't have to renumber.
    out[base + 2] = hidden ? 0 : radii[i]!;
    out[base + 3] = color[0];
    out[base + 4] = color[1];
    out[base + 5] = color[2];

    const dimmed = dimMask !== null && dimMask[i] === 1;

    out[base + 6] = hidden ? 0 : dimmed ? 0.15 : 1;

    let flags = 0;

    if (i === selected) flags |= 1;
    else if (i === hovered) flags |= 2;
    if (cycleMask !== null && cycleMask[i] === 1) flags |= 4;
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
/**
 * Pack edge line vertices with optional node remapping for contraction.
 *
 * When `nodeRemap` is non-null, each endpoint is replaced by its remap
 * entry — `-1` means "drop this endpoint" (hidden with no owner), and
 * equal remaps mean a self-loop after contraction and are also dropped.
 * Surviving edges are deduped by `(from, to)` so a swarm of file→file
 * imports between two packages collapses to a single package→package
 * line.
 */
export function packEdges(
  edgesFlat: Int32Array,
  positions: Float32Array,
  communities: Int32Array,
  out: Float32Array,
  edgeTypeIds: Int32Array | null = null,
  hiddenTypes: Set<number> | null = null,
  nodeRemap: Int32Array | null = null,
): { buffer: Float32Array; vertexCount: number } {
  const E = edgesFlat.length / 2;
  const need = E * 12;

  if (out.length < need) out = new Float32Array(need);

  const filter = edgeTypeIds !== null && hiddenTypes !== null && hiddenTypes.size > 0;
  const N = communities.length;
  const seen = nodeRemap === null ? null : new Set<number>();
  const color: [number, number, number] = [0, 0, 0];
  let k = 0;
  let drawn = 0;

  for (let i = 0; i < E; i++) {
    if (filter && hiddenTypes!.has(edgeTypeIds![i]!)) continue;

    let a = edgesFlat[2 * i]!;
    let b = edgesFlat[2 * i + 1]!;

    if (nodeRemap !== null) {
      a = nodeRemap[a]!;
      b = nodeRemap[b]!;
      if (a < 0 || b < 0) continue;
      if (a === b) continue;

      const key = a * N + b;

      if (seen!.has(key)) continue;
      seen!.add(key);
    }
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
