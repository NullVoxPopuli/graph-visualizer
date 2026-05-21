import { communityColorInto } from "./colors.ts";

/**
 * Pack a node-instance Float32Array (8 floats / 32 bytes per node) directly
 * compatible with the renderer's instanced vertex layout:
 *   (x, y, radius_world, r, g, b, a, flags)
 *
 * `flags` is a small bitmask consumed by the vertex/fragment shader so
 * states compose freely:
 *   bit 1 (2) = hovered      → body grows
 *   bit 2 (4) = cycle member → red outline
 *   bit 3 (8) = dimmed       → vertex shader fades alpha further at low zoom
 *
 * Bit 0 used to be `selected`; the dashed halo is now driven by a
 * `uSelectedIdx` shader uniform instead — clicking a node doesn't
 * have to rewrite the entire instance buffer to flip one bit. See
 * `Renderer.setSelectedIdx` / the `NODE_VS`/`NODE_FS` shaders.
 *
 * `dimMask` is encoded as a flag rather than a baked alpha so the shader
 * can scale the dim with the current zoom level (overlapping nodes hide
 * dimming when zoomed all the way out, so we drop the alpha further when
 * the camera is zoomed out).
 *
 * Reuses `out` if it's large enough; otherwise allocates a new one. Returns
 * the (possibly reallocated) buffer.
 */
export function packNodes(
  positions: Float32Array,
  radii: Float32Array,
  communities: Int32Array,
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
    // Hidden nodes zero out alpha — anything else is "fully opaque" here
    // and the shader picks the dim scale via the flag bit.
    out[base + 6] = hidden ? 0 : 1;

    let flags = 0;

    if (i === hovered) flags |= 2;
    if (cycleMask !== null && cycleMask[i] === 1) flags |= 4;
    if (dimMask !== null && dimMask[i] === 1) flags |= 8;
    out[base + 7] = flags;
  }

  return out;
}

/**
 * Patch only the per-instance `flags` byte (offset 7 of each 8-float
 * instance) in an existing buffer — leaves position, radius, color,
 * and alpha untouched. Use this on selection / hover / dim / cycle
 * changes where the community palette and node geometry haven't
 * moved: it skips the per-node `communityColorInto` HSL→RGB math,
 * which dominates `packNodes` on big graphs (≈20 ms on 100k nodes vs
 * ≈2 ms here).
 *
 * Caller is responsible for ensuring `buf` was built by `packNodes`
 * for the same `(positions, communities, hideMask)` triple — i.e.
 * nothing structural has changed. If those *do* change (graph swap,
 * type filter, layout settle), go back through the full `packNodes`
 * to refresh the static columns too.
 */
export function packNodeFlags(
  buf: Float32Array,
  count: number,
  hovered: number,
  dimMask: Uint8Array | null,
  cycleMask: Uint8Array | null,
): void {
  for (let i = 0; i < count; i++) {
    let flags = 0;

    if (i === hovered) flags |= 2;
    if (cycleMask !== null && cycleMask[i] === 1) flags |= 4;
    if (dimMask !== null && dimMask[i] === 1) flags |= 8;
    buf[i * 8 + 7] = flags;
  }
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
  restrictToNode: number = -1,
  /**
   * When restricting to a node, the caller can pass a precomputed list
   * of that node's incident edge indices so we iterate O(degree) instead
   * of scanning all `E` edges (and size the buffer to the degree, not the
   * whole graph). Only valid with `nodeRemap === null`; ignored otherwise.
   */
  restrictEdges: Int32Array | null = null,
): { buffer: Float32Array; vertexCount: number } {
  const E = edgesFlat.length / 2;
  const useList = restrictEdges !== null && nodeRemap === null;
  const iterN = useList ? restrictEdges.length : E;
  const need = iterN * 12;

  if (out.length < need) out = new Float32Array(need);

  const filter = edgeTypeIds !== null && hiddenTypes !== null && hiddenTypes.size > 0;
  const restrict = restrictToNode >= 0;
  const N = communities.length;
  const seen = nodeRemap === null ? null : new Set<number>();
  const color: [number, number, number] = [0, 0, 0];
  let k = 0;
  let drawn = 0;

  for (let t = 0; t < iterN; t++) {
    const i = useList ? restrictEdges[t]! : t;

    if (filter && hiddenTypes.has(edgeTypeIds[i]!)) continue;

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

    if (restrict && a !== restrictToNode && b !== restrictToNode) continue;

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
 * Pack per-arrow instance data for the directional arrowhead pass.
 *
 * Layout per instance (9 floats / 36 bytes):
 *   (srcX, srcY, tgtX, tgtY, r, g, b, a, srcRadiusWorld)
 *
 * The arrowhead sits at the source end (`edgesFlat[2k]`) — that's the node
 * that listed the edge in its outgoing list, i.e. the importer. Skip
 * filters mirror `packEdges` so arrowheads track the visible edges
 * exactly. With `nodeRemap`, both endpoints route through the contracted
 * graph and duplicates collapse — one arrow per visible (from, to) pair.
 */
export function packArrows(
  edgesFlat: Int32Array,
  positions: Float32Array,
  radii: Float32Array,
  communities: Int32Array,
  out: Float32Array,
  edgeTypeIds: Int32Array | null = null,
  hiddenTypes: Set<number> | null = null,
  nodeRemap: Int32Array | null = null,
  restrictToNode: number = -1,
  /** See `packEdges` — incident-edge list for the O(degree) restricted path. */
  restrictEdges: Int32Array | null = null,
): { buffer: Float32Array; count: number } {
  const E = edgesFlat.length / 2;
  const useList = restrictEdges !== null && nodeRemap === null;
  const iterN = useList ? restrictEdges.length : E;
  const need = iterN * 9;

  if (out.length < need) out = new Float32Array(need);

  const filter = edgeTypeIds !== null && hiddenTypes !== null && hiddenTypes.size > 0;
  const restrict = restrictToNode >= 0;
  const N = communities.length;
  const seen = nodeRemap === null ? null : new Set<number>();
  const color: [number, number, number] = [0, 0, 0];
  let count = 0;

  for (let t = 0; t < iterN; t++) {
    const i = useList ? restrictEdges[t]! : t;

    if (filter && hiddenTypes.has(edgeTypeIds[i]!)) continue;

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

    if (restrict && a !== restrictToNode && b !== restrictToNode) continue;

    const ca = communities[a]!;
    const cb = communities[b]!;
    const cross = ca !== cb;

    communityColorInto(ca, color);

    // Arrowheads are roughly 3× the line's alpha so direction reads even
    // when the lines themselves are dim. Cross-community arrows pop more.
    const alpha = cross ? 0.7 : 0.55;
    const base = count * 9;

    out[base] = positions[2 * a]!;
    out[base + 1] = positions[2 * a + 1]!;
    out[base + 2] = positions[2 * b]!;
    out[base + 3] = positions[2 * b + 1]!;
    out[base + 4] = color[0];
    out[base + 5] = color[1];
    out[base + 6] = color[2];
    out[base + 7] = alpha;
    out[base + 8] = radii[a]!;
    count++;
  }

  return { buffer: out, count };
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
