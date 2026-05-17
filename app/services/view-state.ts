import { trackedObject } from "@ember/reactive/collections";
import Service, { service } from "@ember/service";

import { isLabelFilteredOut, normalizeGlobInput, parseGlobs, serializeGlobs } from "#lib/glob";

import type RouterService from "@ember/routing/router-service";
import type { PanelGeometry } from "#lib/floating-panel";
import type { LoadedGraph } from "#lib/types";

// Values are strings when set, null when explicitly cleared. We keep cleared
// keys in the bag so the next `transitionTo` removes them from the URL —
// Ember leaves omitted keys alone, so a plain `delete` wouldn't actually
// strip them from `location.search`.
type QPs = Record<string, string | null>;

/**
 * Equality used by the `trackedObject` store (and by the explicit
 * pre-write check). All falsy values — `null`, `undefined`, `""` — map
 * to the same logical "param absent" state so swapping between them
 * doesn't dirty any tracked dependency. `"0"`, `"1"`, and other
 * meaningful strings compare strictly.
 */
function qpEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  return (!a && !b) || a === b;
}

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

  /**
   * Fine-grained tracked store, one slot per query param. Replaces a
   * previous coarse `router.currentRoute.queryParams` read inside a
   * getter — that approach made every QP-derived getter depend on the
   * entire route, so a single QP write was dirtying every other
   * QP-derived computation on the service. With `trackedObject`,
   * reading `#qps["cyclesPanelOpen"]` only tracks the
   * `cyclesPanelOpen` slot.
   *
   * **Panel geometry (`infoPanel` / `cyclesPanel`) deliberately is
   * NOT in this store.** Dragging or resizing a panel writes the
   * URL many times a second; we don't want those writes to fire any
   * reactivity at all. Geometry lives in the plain non-tracked
   * `#geometryRaw` field below — modifiers grab its value once at
   * mount, then write back imperatively from the drag / resize
   * handlers. The "Recenter panels" affordance uses
   * `#geometryResetHandlers` to imperatively clear DOM styles
   * alongside the URL.
   *
   * `equals: qpEqual` collapses all falsy values (`null` / `undefined`
   * / `""`) so the sync code doesn't fire spurious changes between
   * representations of "absent".
   */
  #qps: QPs = trackedObject<QPs>({}, { equals: qpEqual });

  /**
   * Non-tracked storage for `infoPanel` / `cyclesPanel` raw query
   * param strings. Reads of this object don't subscribe Glimmer to
   * anything, so the panel-apply modifier won't re-run when a drag
   * tick writes a new value. The URL still updates via the same
   * rAF-batched `transitionTo` path as everything else.
   */
  #geometryRaw: Record<string, string | null> = {};

  /**
   * Callbacks registered by panel `createApplyGeometryModifier`
   * instances; each one clears the panel's inline geometry styles when
   * invoked. `recenterPanels()` drains this Set after clearing the
   * URL, so the DOM resets even though no tracked state is wired up.
   */
  #geometryResetHandlers: Set<() => void> = new Set();

  /** Param keys whose values live in `#geometryRaw` rather than `#qps`. */
  static readonly #GEOMETRY_KEYS: ReadonlySet<string> = new Set([
    "infoPanel",
    "cyclesPanel",
    "orphansPanel",
  ]);

  #frame: number | null = null;
  /** Slot keys with writes that haven't been flushed to the URL yet. */
  #pending: Set<string> | null = null;

  constructor(...args: ConstructorParameters<typeof Service>) {
    super(...args);
    this.router.on("routeDidChange", this.#syncFromRouter);
    // Initial sync in case the page loaded with QPs in the URL — the
    // `routeDidChange` for the boot transition usually fires *after*
    // service instantiation, but doing it both ways is cheap and means
    // first reads on the service don't see an empty store.
    this.#syncFromRouter();
  }

  #syncFromRouter = (): void => {
    const committed = (this.router.currentRoute?.queryParams ?? {}) as Record<
      string,
      string | undefined
    >;

    // Add/update slots that differ. Skip keys we've written but not yet
    // flushed — clobbering them here would erase the user's most recent
    // edit if `routeDidChange` fires for an in-flight previous
    // transition before our own rAF runs. The `qpEqual` falsy-collapse
    // is what stops a `""` ↔ `null` ↔ `undefined` flip-flop between
    // router shape and our own normalization from dirtying a slot.
    for (const [key, val] of Object.entries(committed)) {
      if (this.#pending?.has(key)) continue;

      const desired = val ?? null;

      if (ViewStateService.#GEOMETRY_KEYS.has(key)) {
        // Non-tracked write — no reactivity, modifiers won't re-run.
        this.#geometryRaw[key] = desired;
      } else if (!qpEqual(this.#qps[key], desired)) {
        this.#qps[key] = desired;
      }
    }

    // Clear slots that have dropped out of the URL entirely (e.g. user
    // hit back to a state without `cyclesPanelOpen=1`).
    for (const key of Object.keys(this.#qps)) {
      if (this.#pending?.has(key)) continue;

      if (!(key in committed) && !qpEqual(this.#qps[key], null)) {
        this.#qps[key] = null;
      }
    }

    for (const key of Object.keys(this.#geometryRaw)) {
      if (this.#pending?.has(key)) continue;

      if (!(key in committed) && this.#geometryRaw[key] !== null) {
        this.#geometryRaw[key] = null;
      }
    }
  };

  /** Read the current in-memory value for a param, regardless of which store it lives in. */
  #currentValue(key: string): string | null {
    return ViewStateService.#GEOMETRY_KEYS.has(key)
      ? (this.#geometryRaw[key] ?? null)
      : (this.#qps[key] ?? null);
  }

  #setParam(key: string, value: string | null): void {
    const normalized: string | null = value === null || value === "" ? null : value;

    if (ViewStateService.#GEOMETRY_KEYS.has(key)) {
      // Non-tracked write: just stash the raw value. Modifiers reading
      // geometry at mount time will see this, but on-going drag /
      // resize writes won't trigger any Glimmer re-renders.
      this.#geometryRaw[key] = normalized;
    } else if (!qpEqual(this.#qps[key], normalized)) {
      // Tracked write — the store's own `equals: qpEqual` already
      // short-circuits redundant assignments, but skipping the proxy
      // round-trip with an explicit falsy-equal check shaves the
      // slowest path on rapid writes (e.g. slider drags).
      this.#qps[key] = normalized;
    }

    if (this.#pending === null) this.#pending = new Set();
    this.#pending.add(key);

    if (this.#frame !== null) cancelAnimationFrame(this.#frame);

    this.#frame = requestAnimationFrame(() => {
      const keys = this.#pending ?? new Set<string>();

      this.#frame = null;
      this.#pending = null;

      const qps: QPs = {};

      for (const k of keys) qps[k] = this.#currentValue(k);
      void this.router.transitionTo({ queryParams: qps });
    });
  }

  /**
   * Run any pending rAF-batched QP transition immediately and return its
   * promise. Needed for callers that have to observe the URL/DOM update
   * synchronously with their own work — notably the View Transition
   * callback, where rAFs are suspended until the callback resolves, so
   * the normal batching deadlocks the toggle.
   */
  async flushPending(): Promise<void> {
    if (this.#frame === null) return;
    cancelAnimationFrame(this.#frame);
    this.#frame = null;

    const keys = this.#pending ?? new Set<string>();

    this.#pending = null;

    const qps: QPs = {};

    for (const k of keys) qps[k] = this.#currentValue(k);
    await this.router.transitionTo({ queryParams: qps });
  }

  /**
   * Register a callback that clears a panel's inline geometry styles.
   * Invoked by `recenterPanels()` alongside the URL clear so the DOM
   * actually resets — since geometry isn't tracked, the apply modifier
   * doesn't auto-respond to URL writes anymore. Returns an unregister
   * function the modifier's cleanup uses.
   */
  registerGeometryReset(cb: () => void): () => void {
    this.#geometryResetHandlers.add(cb);

    return () => {
      this.#geometryResetHandlers.delete(cb);
    };
  }

  /**
   * Clear both saved panel geometries (URL + in-memory) and ask every
   * registered apply modifier to wipe its element's inline styles so
   * the CSS defaults take over immediately.
   */
  recenterPanels(): void {
    this.#setParam("infoPanel", null);
    this.#setParam("cyclesPanel", null);
    this.#setParam("orphansPanel", null);
    for (const cb of this.#geometryResetHandlers) cb();
  }

  // ---- typed aliases

  get showEdges(): boolean {
    return this.#qps["edges"] !== "0";
  }
  set showEdges(v: boolean) {
    // Default true; only encode the off state.
    this.#setParam("edges", v ? null : "0");
  }

  get showHulls(): boolean {
    return this.#qps["hulls"] === "1";
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
    return this.#qps["arrows"] !== "0";
  }
  set showArrows(v: boolean) {
    this.#setParam("arrows", v ? null : "0");
  }

  get hiddenEdgeTypes(): Set<number> {
    return parseIntSet(this.#qps["hiddenEdgeTypes"]);
  }

  toggleHiddenEdgeType(id: number): void {
    this.#setParam("hiddenEdgeTypes", serializeIntSet(toggleInSet(this.hiddenEdgeTypes, id)));
  }

  get hiddenNodeTypes(): Set<number> {
    return parseIntSet(this.#qps["hiddenNodeTypes"]);
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
    const raw = this.#qps["collapsed"];

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
    const raw = this.#qps["hiddenNodes"];

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

  /**
   * Ids of nodes the user has declared intentional *roots* for orphan
   * detection (via the orphans-panel "declare root" button). A root is
   * treated as always present: it's never reported as an orphan, and
   * anything reachable only through it stops being reported too.
   * Independent of `hiddenNodeIds` — a root still renders on the canvas
   * and participates in every other analysis. Ids containing a literal
   * `,` cannot round-trip through this URL encoding.
   */
  get rootNodeIds(): Set<string> {
    const raw = this.#qps["rootNodes"];

    if (!raw) return EMPTY_STRING_SET;

    return new Set(raw.split(",").filter((s) => s.length > 0));
  }

  toggleRootNodeId(id: string): void {
    const next = new Set(this.rootNodeIds);

    if (next.has(id)) next.delete(id);
    else next.add(id);

    const serialized = next.size === 0 ? null : [...next].join(",");

    this.#setParam("rootNodes", serialized);
  }

  clearRootNodes(): void {
    this.#setParam("rootNodes", null);
  }

  /**
   * Label glob include / exclude lists. A label is shown when it
   * matches any include glob (or the include list is empty) AND does
   * not match any exclude glob. Encoded in the URL as pipe-separated
   * strings — globs almost never contain `|`, and choosing it as the
   * separator keeps the URL readable. Patterns containing `|` are
   * rejected at add time.
   */
  get includeGlobs(): string[] {
    return parseGlobs(this.#qps["includeGlobs"]);
  }

  get excludeGlobs(): string[] {
    return parseGlobs(this.#qps["excludeGlobs"]);
  }

  addIncludeGlob(raw: string): void {
    const next = normalizeGlobInput(raw);

    if (next === null) return;

    const current = this.includeGlobs;

    if (current.includes(next)) return;

    this.#setParam("includeGlobs", serializeGlobs([...current, next]));
  }

  removeIncludeGlob(pattern: string): void {
    const next = this.includeGlobs.filter((g) => g !== pattern);

    this.#setParam("includeGlobs", serializeGlobs(next));
  }

  addExcludeGlob(raw: string): void {
    const next = normalizeGlobInput(raw);

    if (next === null) return;

    const current = this.excludeGlobs;

    if (current.includes(next)) return;

    this.#setParam("excludeGlobs", serializeGlobs([...current, next]));
  }

  removeExcludeGlob(pattern: string): void {
    const next = this.excludeGlobs.filter((g) => g !== pattern);

    this.#setParam("excludeGlobs", serializeGlobs(next));
  }

  /**
   * Resolve include/exclude globs against a loaded graph and return the
   * union of explicit `hiddenNodeIds` plus every id whose label is
   * filtered out by the glob rules. Used at each `buildContraction`
   * call site so the glob filter shares the same hide-by-id machinery
   * as the per-node "Hide" button — every consumer that already
   * respects `hiddenNodeIds` picks up the new filter automatically.
   *
   * Returns the original `hiddenNodeIds` set unchanged when neither
   * glob list has anything in it, so the fast path doesn't allocate.
   */
  effectiveHiddenNodeIds(graph: LoadedGraph): Set<string> {
    const include = this.includeGlobs;
    const exclude = this.excludeGlobs;
    const base = this.hiddenNodeIds;

    if (include.length === 0 && exclude.length === 0) return base;

    const out = new Set(base);
    const { labels, ids } = graph;

    for (let i = 0; i < labels.length; i++) {
      if (isLabelFilteredOut(labels[i]!, include, exclude)) out.add(ids[i]!);
    }

    return out;
  }

  /**
   * Drop every URL-backed setting that's tied to the specific graph
   * that *was* loaded — selection, hidden node ids, collapsed toggles,
   * type filters, edge-type filters. Type-filter / edge-type ids index
   * into the previous graph's interned name lists, so leaving them in
   * place after a swap silently filters by the wrong type. Layout
   * sliders, panel geometry, and the panel open/close stay put because
   * they're graph-agnostic.
   */
  resetGraphSpecific(): void {
    this.#setParam("selected", null);
    this.#setParam("collapsed", null);
    this.#setParam("hiddenNodes", null);
    this.#setParam("rootNodes", null);
    this.#setParam("hiddenNodeTypes", null);
    this.#setParam("hiddenEdgeTypes", null);
    // Glob filters are technically graph-agnostic — the same `**/*.test.ts`
    // pattern would work on any codebase — but in practice they're
    // tuned to a specific repo's labels, so a new graph load gets a
    // fresh slate to avoid surprise "where did my nodes go" moments.
    this.#setParam("includeGlobs", null);
    this.#setParam("excludeGlobs", null);
  }

  /** Selected node id as it appears in the input JSON (string form), or null. */
  get selectedId(): string | null {
    const v = this.#qps["selected"];

    return v && v.length > 0 ? v : null;
  }
  set selectedId(v: string | null) {
    this.#setParam("selected", v);
  }

  /** Repulsion force fed into the d3-force charge body. */
  get repulsion(): number {
    const v = this.#qps["repulsion"];
    const n = typeof v === "string" ? Number.parseFloat(v) : NaN;

    return Number.isFinite(n) ? n : DEFAULT_REPULSION;
  }
  set repulsion(n: number) {
    this.#setParam("repulsion", n === DEFAULT_REPULSION ? null : String(n));
  }

  /** Spring length for edges that stay inside a community. */
  get nodeDistance(): number {
    const v = this.#qps["nodeDistance"];
    const n = typeof v === "string" ? Number.parseFloat(v) : NaN;

    return Number.isFinite(n) ? n : DEFAULT_NODE_DISTANCE;
  }
  set nodeDistance(n: number) {
    this.#setParam("nodeDistance", n === DEFAULT_NODE_DISTANCE ? null : String(n));
  }

  /** Spring length for edges that cross community boundaries. */
  get clusterDistance(): number {
    const v = this.#qps["clusterDistance"];
    const n = typeof v === "string" ? Number.parseFloat(v) : NaN;

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
    const v = this.#qps["clustering"];
    const n = typeof v === "string" ? Number.parseFloat(v) : NaN;

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
    return this.#qps["labelCluster"] === "1";
  }
  set clusterByLabel(v: boolean) {
    this.#setParam("labelCluster", v ? "1" : null);
  }

  /**
   * Whether the cycles panel is visible. **Off** by default — opening it
   * runs `findAllCycles` on the loaded graph, which is exponential in the
   * worst case and easily freezes the tab when a large file is dropped.
   * The user opts in explicitly when they want the analysis.
   */
  get cyclesPanelOpen(): boolean {
    return this.#qps["cyclesPanelOpen"] === "1";
  }
  set cyclesPanelOpen(v: boolean) {
    this.#setParam("cyclesPanelOpen", v ? "1" : null);
  }

  /**
   * Whether the orphans panel is visible. Off by default; the user
   * opts in via the "Show orphans" button. Orphan analysis is linear
   * (O(N + E)) so we could safely auto-open, but the panel takes
   * screen space and most users won't care about orphans in passing.
   */
  get orphansPanelOpen(): boolean {
    return this.#qps["orphansPanelOpen"] === "1";
  }
  set orphansPanelOpen(v: boolean) {
    this.#setParam("orphansPanelOpen", v ? "1" : null);
  }

  /**
   * Whether the top-left controls panel is expanded. With no explicit
   * choice in the URL it defaults to *open* on roomy screens but
   * *collapsed* on small / portrait ones, where the panel would
   * otherwise cover most of the viewport. Because the default is
   * screen-size dependent, "open" can no longer be represented by an
   * absent param — both states are encoded explicitly once the user
   * toggles.
   */
  get controlsOpen(): boolean {
    const v = this.#qps["controls"];

    if (v === "0") return false;
    if (v === "1") return true;

    return !isSmallScreen();
  }
  set controlsOpen(v: boolean) {
    this.#setParam("controls", v ? "1" : "0");
  }

  /**
   * Info panel geometry. Non-tracked: reads pull from `#geometryRaw`
   * (not the tracked `#qps`), so a drag/resize that calls the setter
   * many times a second doesn't trigger any Glimmer re-renders. Panel
   * modifiers read this once at mount and apply it to the DOM; from
   * then on the drag handler writes inline styles itself.
   */
  get infoPanelGeometry(): PanelGeometry | null {
    return parsePanelGeometry(this.#geometryRaw["infoPanel"]);
  }
  set infoPanelGeometry(g: PanelGeometry | null) {
    this.#setParam("infoPanel", serializePanelGeometry(g));
  }

  /**
   * Per-section open/close override for the info panel's in / out /
   * cycles details elements. `null` means "follow the auto-default"
   * (open when the section is short, collapsed when long) so a fresh
   * URL behaves the same as before. The override is only encoded when
   * the user's choice *disagrees* with the auto-default — toggling a
   * section back to its natural state clears the URL key.
   */
  get infoInOpenOverride(): boolean | null {
    return parseTri(this.#qps["infoIn"]);
  }
  set infoInOpenOverride(v: boolean | null) {
    this.#setParam("infoIn", serializeTri(v));
  }

  get infoOutOpenOverride(): boolean | null {
    return parseTri(this.#qps["infoOut"]);
  }
  set infoOutOpenOverride(v: boolean | null) {
    this.#setParam("infoOut", serializeTri(v));
  }

  get infoCyclesOpenOverride(): boolean | null {
    return parseTri(this.#qps["infoCycles"]);
  }
  set infoCyclesOpenOverride(v: boolean | null) {
    this.#setParam("infoCycles", serializeTri(v));
  }

  /**
   * Cycles panel geometry, encoded as `left,top,width,height` in CSS px.
   * Non-tracked, same as `infoPanelGeometry`: reads come from
   * `#geometryRaw` and the setter only updates that field + the URL,
   * never the tracked store.
   */
  get cyclesPanelGeometry(): PanelGeometry | null {
    return parsePanelGeometry(this.#geometryRaw["cyclesPanel"]);
  }
  set cyclesPanelGeometry(g: PanelGeometry | null) {
    this.#setParam("cyclesPanel", serializePanelGeometry(g));
  }

  /**
   * Orphans panel geometry. Same non-tracked treatment as the cycles
   * panel — drag/resize writes don't fire any reactivity, and the
   * apply modifier reads this exactly once on mount.
   */
  get orphansPanelGeometry(): PanelGeometry | null {
    return parsePanelGeometry(this.#geometryRaw["orphansPanel"]);
  }
  set orphansPanelGeometry(g: PanelGeometry | null) {
    this.#setParam("orphansPanel", serializePanelGeometry(g));
  }
}

/**
 * Matches the `max-width: 768px` breakpoint the stylesheet uses to
 * drop the HUD cycle status — keep the two in sync so "small screen"
 * means the same thing in CSS and in the controls-default logic.
 * SSR-safe: no `window` during prerender, so treat that as roomy.
 */
const SMALL_SCREEN_MAX = 768;

function isSmallScreen(): boolean {
  return typeof window !== "undefined" && window.innerWidth <= SMALL_SCREEN_MAX;
}

function parseTri(v: string | null | undefined): boolean | null {
  if (v === "1") return true;
  if (v === "0") return false;

  return null;
}

function serializeTri(v: boolean | null): string | null {
  if (v === null) return null;

  return v ? "1" : "0";
}

function parsePanelGeometry(raw: string | undefined | null): PanelGeometry | null {
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

function serializePanelGeometry(g: PanelGeometry | null): string | null {
  if (g === null) return null;

  // Round to integers — sub-pixel precision is wasted on a 1px-grid panel
  // and the URL stays readable.
  const fmt = (n: number | null): string => (n === null ? "" : `${Math.round(n)}`);
  const serialized = [fmt(g.left), fmt(g.top), fmt(g.width), fmt(g.height)].join(",");

  return serialized === ",,," ? null : serialized;
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
