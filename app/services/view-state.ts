import Service, { service } from "@ember/service";

import type RouterService from "@ember/routing/router-service";

// Values are strings when set, null when explicitly cleared. We keep cleared
// keys in the bag so the next `transitionTo` removes them from the URL —
// Ember leaves omitted keys alone, so a plain `delete` wouldn't actually
// strip them from `location.search`.
type QPs = Record<string, string | null>;

/**
 * Single source of truth for UI state that is meaningful to remember across
 * reloads / shareable URLs:
 *
 *   edges             — show edges                          (1/0, default 1)
 *   hulls             — show cluster hulls                  (1/0, default 0)
 *   hiddenEdgeTypes   — comma-separated edge type ids filtered out
 *   hiddenNodeTypes   — comma-separated node type ids filtered out
 *   collapsed         — comma-separated node ids whose targets are inverted
 *   selected          — selected node id (string from input JSON)
 *   repulsion         — repulsion force                     (number, default 6)
 *   nodeDistance      — intra-cluster spring length         (number, default 18)
 *   clusterDistance   — inter-cluster spring length         (number, default 180)
 *
 * Reads come from `router.currentRoute.queryParams`. Writes go through
 * `router.transitionTo({ queryParams })`, batched on rAF so a flurry of
 * rapid setters (e.g. clicking through nodes) coalesces into a single
 * transition — multiple in-flight transitions cancel each other and the
 * URL ends up out of sync with what the user actually picked.
 */
export const DEFAULT_REPULSION = 6;
export const DEFAULT_NODE_DISTANCE = 18;
export const DEFAULT_CLUSTER_DISTANCE = 180;
export const DEFAULT_CLUSTERING = 1;

export default class ViewStateService extends Service {
  @service declare router: RouterService;

  // Reads merge the router's committed query params with any not-yet-flushed
  // writes from `#pending`, so two rapid toggles read the just-set value
  // instead of the (stale) value the router still has.
  get #queryParams(): QPs {
    const committed = (this.router.currentRoute?.queryParams ?? {}) as QPs;

    return this.#pending === null ? committed : { ...committed, ...this.#pending };
  }

  #frame: number | null = null;
  #pending: QPs | null = null;

  #setParam(key: string, value: string | null): void {
    const next: QPs = { ...this.#queryParams };

    next[key] = value === null || value === "" ? null : value;
    this.#pending = next;

    if (this.#frame !== null) cancelAnimationFrame(this.#frame);

    this.#frame = requestAnimationFrame(() => {
      const qps = this.#pending ?? {};

      this.#frame = null;
      this.#pending = null;
      void this.router.transitionTo({ queryParams: qps });
    });
  }

  // ---- typed aliases

  get showEdges(): boolean {
    return this.#queryParams["edges"] !== "0";
  }
  set showEdges(v: boolean) {
    // Default true; only encode the off state.
    this.#setParam("edges", v ? null : "0");
  }

  get showHulls(): boolean {
    return this.#queryParams["hulls"] === "1";
  }
  set showHulls(v: boolean) {
    this.#setParam("hulls", v ? "1" : null);
  }

  /**
   * Whether to draw the directional arrowhead at the source end of each
   * edge (the node that listed the edge in its outgoing list). On by
   * default — the URL only encodes the off state.
   */
  get showArrows(): boolean {
    return this.#queryParams["arrows"] !== "0";
  }
  set showArrows(v: boolean) {
    this.#setParam("arrows", v ? null : "0");
  }

  get hiddenEdgeTypes(): Set<number> {
    return parseIntSet(this.#queryParams["hiddenEdgeTypes"]);
  }

  toggleHiddenEdgeType(id: number): void {
    this.#setParam("hiddenEdgeTypes", serializeIntSet(toggleInSet(this.hiddenEdgeTypes, id)));
  }

  get hiddenNodeTypes(): Set<number> {
    return parseIntSet(this.#queryParams["hiddenNodeTypes"]);
  }

  toggleHiddenNodeType(id: number): void {
    this.#setParam("hiddenNodeTypes", serializeIntSet(toggleInSet(this.hiddenNodeTypes, id)));
  }

  /**
   * Per-node toggle: ids of nodes whose outgoing targets' visibility the
   * user has flipped via double-click. The set composes with the type
   * filter as XOR — a node listed here means each of its direct outgoing
   * targets gets its `hiddenNodeTypes` baseline inverted. So with no type
   * filter active it collapses, with `file` hidden it expands those files
   * back, and toggling the same node twice returns to the baseline. Ids
   * containing a literal `,` cannot round-trip through this URL encoding.
   */
  get collapsedIds(): Set<string> {
    const raw = this.#queryParams["collapsed"];

    if (!raw) return EMPTY_STRING_SET;

    return new Set(raw.split(",").filter((s) => s.length > 0));
  }

  toggleCollapsed(id: string): void {
    const next = new Set(this.collapsedIds);

    if (next.has(id)) next.delete(id);
    else next.add(id);

    const serialized = next.size === 0 ? null : [...next].join(",");

    this.#setParam("collapsed", serialized);
  }

  clearCollapsed(): void {
    this.#setParam("collapsed", null);
  }

  /**
   * Ids of individual nodes the user has explicitly hidden from the graph
   * (via the info-panel "Hide" button). Hidden nodes vanish from the
   * canvas, their edges drop out, and they don't participate in cycle
   * detection. Distinct from `hiddenNodeTypes` (which hides by category)
   * and `collapsedIds` (which folds children). Ids containing a literal
   * `,` cannot round-trip through this URL encoding.
   */
  get hiddenNodeIds(): Set<string> {
    const raw = this.#queryParams["hiddenNodes"];

    if (!raw) return EMPTY_STRING_SET;

    return new Set(raw.split(",").filter((s) => s.length > 0));
  }

  toggleHiddenNodeId(id: string): void {
    const next = new Set(this.hiddenNodeIds);

    if (next.has(id)) next.delete(id);
    else next.add(id);

    const serialized = next.size === 0 ? null : [...next].join(",");

    this.#setParam("hiddenNodes", serialized);
  }

  clearHiddenNodes(): void {
    this.#setParam("hiddenNodes", null);
  }

  /** Selected node id as it appears in the input JSON (string form), or null. */
  get selectedId(): string | null {
    const v = this.#queryParams["selected"];

    return v && v.length > 0 ? v : null;
  }
  set selectedId(v: string | null) {
    this.#setParam("selected", v);
  }

  /** Repulsion force fed into the d3-force charge body. */
  get repulsion(): number {
    const v = this.#queryParams["repulsion"];
    const n = v === undefined ? NaN : Number.parseFloat(v);

    return Number.isFinite(n) ? n : DEFAULT_REPULSION;
  }
  set repulsion(n: number) {
    this.#setParam("repulsion", n === DEFAULT_REPULSION ? null : String(n));
  }

  /** Spring length for edges that stay inside a community. */
  get nodeDistance(): number {
    const v = this.#queryParams["nodeDistance"];
    const n = v === undefined ? NaN : Number.parseFloat(v);

    return Number.isFinite(n) ? n : DEFAULT_NODE_DISTANCE;
  }
  set nodeDistance(n: number) {
    this.#setParam("nodeDistance", n === DEFAULT_NODE_DISTANCE ? null : String(n));
  }

  /** Spring length for edges that cross community boundaries. */
  get clusterDistance(): number {
    const v = this.#queryParams["clusterDistance"];
    const n = v === undefined ? NaN : Number.parseFloat(v);

    return Number.isFinite(n) ? n : DEFAULT_CLUSTER_DISTANCE;
  }
  set clusterDistance(n: number) {
    this.#setParam("clusterDistance", n === DEFAULT_CLUSTER_DISTANCE ? null : String(n));
  }

  /**
   * Louvain resolution. Higher values produce more, smaller communities
   * (less "clingy"); lower values merge them (more "clingy"). 1 = Louvain's
   * default modularity weighting.
   */
  get clustering(): number {
    const v = this.#queryParams["clustering"];
    const n = v === undefined ? NaN : Number.parseFloat(v);

    return Number.isFinite(n) && n > 0 ? n : DEFAULT_CLUSTERING;
  }
  set clustering(n: number) {
    this.#setParam("clustering", n === DEFAULT_CLUSTERING ? null : String(n));
  }

  /**
   * When on, skip Louvain and bucket nodes by their label's path-style
   * parent prefix (split on "/" or ".") — useful when the graph is
   * organized by file path / package and topology-based communities don't
   * line up with intuitive groupings. Off by default.
   */
  get clusterByLabel(): boolean {
    return this.#queryParams["labelCluster"] === "1";
  }
  set clusterByLabel(v: boolean) {
    this.#setParam("labelCluster", v ? "1" : null);
  }

  /**
   * Cycles panel geometry, encoded as `left,top,width,height` in CSS px.
   * `null` for any field means "use the default" (CSS-defined). The whole
   * value drops out of the URL when nothing has been moved or resized.
   */
  get cyclesPanelGeometry(): PanelGeometry | null {
    const raw = this.#queryParams["cyclesPanel"];

    if (!raw) return null;

    const parts = raw.split(",").map((s) => Number.parseFloat(s));

    if (parts.length !== 4) return null;

    const [left, top, width, height] = parts;

    return {
      left: Number.isFinite(left!) ? left! : null,
      top: Number.isFinite(top!) ? top! : null,
      width: Number.isFinite(width!) ? width! : null,
      height: Number.isFinite(height!) ? height! : null,
    };
  }
  set cyclesPanelGeometry(g: PanelGeometry | null) {
    if (g === null) {
      this.#setParam("cyclesPanel", null);

      return;
    }

    // Round to integers — the panel never needs sub-pixel precision and
    // it keeps the URL readable.
    const fmt = (n: number | null): string => (n === null ? "" : `${Math.round(n)}`);
    const serialized = [fmt(g.left), fmt(g.top), fmt(g.width), fmt(g.height)].join(",");

    this.#setParam("cyclesPanel", serialized === ",,," ? null : serialized);
  }
}

export interface PanelGeometry {
  left: number | null;
  top: number | null;
  width: number | null;
  height: number | null;
}

const EMPTY_SET: Set<number> = Object.freeze(new Set<number>());
const EMPTY_STRING_SET: Set<string> = Object.freeze(new Set<string>());

function parseIntSet(raw: string | undefined | null): Set<number> {
  if (!raw) return EMPTY_SET;

  const out = new Set<number>();

  for (const tok of raw.split(",")) {
    const n = Number.parseInt(tok, 10);

    if (Number.isFinite(n)) out.add(n);
  }

  return out;
}

function serializeIntSet(set: Set<number>): string | null {
  if (set.size === 0) return null;

  return [...set].sort((a, b) => a - b).join(",");
}

function toggleInSet(set: Set<number>, id: number): Set<number> {
  const next = new Set(set);

  if (next.has(id)) next.delete(id);
  else next.add(id);

  return next;
}
