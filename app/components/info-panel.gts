import Component from "@glimmer/component";
import { cached, tracked } from "@glimmer/tracking";
import { action } from "@ember/object";
import { service } from "@ember/service";

import { getPromiseState } from "reactiveweb/get-promise-state";

import { toggleInSet } from "#lib/collapse-list";
import { buildContraction } from "#lib/contract";
import { bundleRawCyclesWithGroups, canonicalCycleKey, shortCycleId } from "#lib/cycle";
import {
  createApplyGeometryModifier,
  createDragModifier,
  createResizeModifier,
} from "#lib/floating-panel";
import { computeRadii } from "#lib/pack";
import IconArrowElbowDownRight from "~icons/ph/arrow-elbow-down-right";
import IconArrowRight from "~icons/ph/arrow-right";
import IconCaretRight from "~icons/ph/caret-right";
import IconX from "~icons/ph/x";

import type { PanelGeometry } from "#lib/floating-panel";
import type { LoadedGraph } from "#lib/types";
import type GraphService from "#services/graph";
import type ViewStateService from "#services/view-state";
import type VisualizerService from "#services/visualizer";

interface NeighborEntry {
  id: string;
  label: string;
}

interface RawCycleFile {
  id: string;
  label: string;
}

/**
 * NeighborEntry plus the raw file(s) that contracted into this
 * bundled step. `rawFiles` is empty when no contraction folded a file
 * here (raw == bundled). Used so the cycles panel can surface the
 * underlying file labels when a node type is hidden — same package
 * can appear twice in one cycle, and seeing the file at each
 * occurrence is what makes the cycle readable.
 */
interface CycleNodeEntry extends NeighborEntry {
  rawFiles: RawCycleFile[];
}

interface DisplayedCycleNode {
  /** 1-based position in the bundled cycle. */
  index: number;
  node: CycleNodeEntry;
}

/**
 * One displayed chunk inside a cycle's node list. Adjacent nodes that
 * share the same canonical cycle id (smallest cycle they appear in)
 * are grouped together; segments with `cycleId` set render as a
 * `cycle#N` chip (collapsed by default, click to expand inline), and
 * segments without it render the actual node rows. Flat shape rather
 * than a discriminated union so Glint can narrow on `{{#if seg.cycleId}}`
 * in the template.
 */
interface CycleSegment {
  key: string;
  nodes: DisplayedCycleNode[];
  /**
   * Short cycle id of the smaller cycle this segment's nodes belong
   * to. `undefined` on `own` segments. Glint narrows on
   * `{{#if seg.cycleId}}` in the template.
   */
  cycleId?: string;
}

interface CycleEntry {
  /** Bundled cycle — the visible reps the canvas red-rings. */
  nodes: CycleNodeEntry[];
  /**
   * Short deterministic id derived from the canonical cycle key
   * (`shortCycleId`). 8 lower-case hex chars, stable across reloads.
   */
  id: string;
  segments: CycleSegment[];
  /**
   * `"1 cycle"` / `"5 cycles"` computed from this cycle's ref
   * segments — empty string when the cycle is wholly its own nodes.
   * Pre-formatted so the template can render the heading with a
   * single mustache.
   */
  containedLabel: string;
  /** stable key for `{{#each}}` — deterministic per bundled cycle. */
  key: string;
}

interface SelectedInfo {
  index: number;
  id: string;
  label: string;
  type: string;
  meta: unknown;
}

/**
 * Row in the "Most referenced" summary at the top of the cycles
 * section. `entry` is the underlying CycleEntry (so the template can
 * reuse the same segment rendering); `count` is the number of distinct
 * cycles in the displayed list that ref this one. Sorted descending,
 * capped at 3.
 */
interface TopReferencedEntry {
  entry: CycleEntry;
  count: number;
}

export default class InfoPanel extends Component {
  @service declare viewState: ViewStateService;
  @service declare graph: GraphService;
  @service declare visualizer: VisualizerService;

  /**
   * Memoize the fully-built CycleEntry list keyed on every input that
   * actually affects which cycles appear and how they render. Without
   * this, `toggleCycleHeader` was triggering a full `findBundledCycles`
   * re-enumeration: the toggle dirties `collapsedHeaders`, which
   * invalidates `allCyclesCollapsed`, which reads `this.cycles`, which
   * (untracked-cached) re-ran the exponential cycle search on every
   * read. With the cache in place, only the per-cycle `{{#unless}}`
   * predicates re-evaluate when the user collapses a cycle.
   */
  #lastGraph: LoadedGraph | null = null;
  #lastCycleKey = "";
  #lastEntries: CycleEntry[] = [];

  /**
   * Cached top-3 most-referenced cycles, keyed off the `#lastEntries`
   * reference. Cheap to recompute (O(entries × ref segments)) but
   * recomputing on every read would still allocate, and the result
   * never changes unless `entries` does — so memoizing keeps the
   * "Most referenced" section's render path entirely allocation-free
   * during collapse/expand toggles.
   */
  #lastTopSource: CycleEntry[] | null = null;
  #lastTop: TopReferencedEntry[] = [];

  /**
   * Cycle keys whose body (node list + occurrences table) the user has
   * collapsed. Cycle bodies render by default; clicking the header
   * adds the cycle here and the row becomes just its `cycle#N` label.
   * The inner node-list collapse (head/hidden/tail) and the
   * occurrences-list collapse have their own tracked sets below.
   */
  @tracked private collapsedHeaders: Set<string> = new Set();

  /**
   * Cycle-ref segment keys the user has expanded inline inside a
   * cycle's node list. Each `cycle#N` chip in a cycle's body collapses
   * by default; clicking it adds the segment key here and the
   * referenced cycle's nodes render in place.
   */
  @tracked private expandedRefs: Set<string> = new Set();

  /**
   * Cycle ids the user has expanded in the "Most referenced" summary
   * at the top of the cycles section. Lives in its own set so the
   * summary defaults to *collapsed* (absent = collapsed) without
   * fighting the main list's "expanded unless in collapsedHeaders"
   * convention.
   */
  @tracked private expandedTopHeaders: Set<string> = new Set();

  @action
  toggleCycleHeader(key: string): void {
    this.collapsedHeaders = toggleInSet(this.collapsedHeaders, key);
  }

  @action
  toggleCycleRef(segKey: string): void {
    this.expandedRefs = toggleInSet(this.expandedRefs, segKey);
  }

  @action
  toggleTopHeader(key: string): void {
    this.expandedTopHeaders = toggleInSet(this.expandedTopHeaders, key);
  }

  /**
   * The three most-referenced cycles inside the currently displayed
   * list — cycles whose id appears as a `cycle#…` ref segment inside
   * the body of other cycles. The count is the number of *distinct
   * containing cycles* (each container only votes once, even when it
   * happens to mention the same ref id in two non-adjacent segment
   * groups). Sorted descending, capped at 3; returns an empty array
   * when no cycle is referenced by any other. Cached off the
   * `this.cycles` reference — toggling collapse/expand state never
   * recomputes this.
   */
  get topReferencedCycles(): TopReferencedEntry[] {
    const entries = this.cycles;

    if (this.#lastTopSource === entries) return this.#lastTop;

    const refCounts = new Map<string, number>();

    for (const entry of entries) {
      // Walk this entry's segments once and collect the distinct ref
      // cycle ids. A container counts as "referencing" a smaller
      // cycle once regardless of how many segment groups mention it.
      const seen = new Set<string>();

      for (const seg of entry.segments) {
        if (seg.cycleId !== undefined) seen.add(seg.cycleId);
      }

      for (const refId of seen) {
        refCounts.set(refId, (refCounts.get(refId) ?? 0) + 1);
      }
    }

    const entryById = new Map<string, CycleEntry>();

    for (const entry of entries) entryById.set(entry.id, entry);

    const ranked: TopReferencedEntry[] = [];

    for (const [refId, count] of refCounts) {
      const entry = entryById.get(refId);

      // Ref ids that don't resolve to a displayed entry can happen if
      // the canonical-cycle map was wider than the entries list —
      // currently they're always in sync, but guard anyway so a future
      // change doesn't silently drop counts.
      if (entry !== undefined) ranked.push({ entry, count });
    }

    ranked.sort((a, b) => b.count - a.count);

    const top = ranked.slice(0, 3);

    // eslint-disable-next-line ember/no-side-effects
    this.#lastTopSource = entries;
    // eslint-disable-next-line ember/no-side-effects
    this.#lastTop = top;

    return top;
  }

  /**
   * True when every visible cycle's header has been collapsed (or the
   * list is empty — handled separately at the call site). Drives the
   * "Collapse all" ↔ "Expand all" label on the section header's
   * toggle button.
   */
  get allCyclesCollapsed(): boolean {
    const cycles = this.cycles;

    if (cycles.length === 0) return false;

    for (const cycle of cycles) {
      if (!this.collapsedHeaders.has(cycle.key)) return false;
    }

    return true;
  }

  /**
   * Bulk collapse / expand all cycles in this info-panel session.
   * Lives inside the section `<summary>` so it intercepts the click
   * (preventDefault + stopPropagation) — without that, the parent
   * `<details>` would toggle the *section* open/closed as well.
   */
  @action
  toggleAllCycles(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();

    if (this.allCyclesCollapsed) {
      this.collapsedHeaders = new Set();

      return;
    }

    const next = new Set<string>();

    for (const cycle of this.cycles) next.add(cycle.key);
    this.collapsedHeaders = next;
  }

  /**
   * Resolve the URL-encoded selected id to a typed SelectedInfo from the
   * loaded graph. Returns null when nothing's selected, no graph is loaded,
   * or the id isn't in the graph (e.g., stale URL after the user dropped a
   * different file).
   */
  @cached
  get info(): SelectedInfo | null {
    const id = this.viewState.selectedId;
    const g = this.graph.current;

    if (id === null || !g) return null;

    const idx = g.idToIndex.get(id);

    if (idx === undefined) return null;

    return {
      index: idx,
      id: g.ids[idx]!,
      label: g.labels[idx]!,
      type: g.nodeTypeNames[g.nodeTypeIds[idx] ?? 0] ?? "",
      meta: g.metas[idx],
    };
  }

  /**
   * Nodes whose `edges` arrays list the selected node — i.e. the nodes
   * that depend on / import the selected one. Direct, deduped, sorted by
   * label.
   */
  @cached
  get inNeighbors(): NeighborEntry[] {
    const info = this.info;
    const g = this.graph.current;

    if (!info || !g) return [];

    const edges = g.edgesFlat;
    const seen = new Set<number>();
    const out: NeighborEntry[] = [];

    for (let k = 0; k < edges.length; k += 2) {
      if (edges[k + 1] !== info.index) continue;

      const src = edges[k]!;

      if (seen.has(src)) continue;
      seen.add(src);
      out.push({ id: g.ids[src]!, label: g.labels[src]! });
    }

    out.sort((a, b) => a.label.localeCompare(b.label));

    return out;
  }

  /**
   * Just the deduped count of incoming neighbors. A single O(E) scan with
   * no array materialization or `localeCompare` sort — this is what the
   * `<summary>` badge, the auto-open threshold, and the `{{#if}}` guard
   * read, so selecting a 27k-edge hub doesn't pay to build and sort the
   * full list (the template only materializes `inNeighbors` once the
   * section is actually expanded).
   */
  @cached
  get inNeighborCount(): number {
    const info = this.info;
    const g = this.graph.current;

    if (!info || !g) return 0;

    const edges = g.edgesFlat;
    const seen = new Set<number>();

    for (let k = 0; k < edges.length; k += 2) {
      if (edges[k + 1] === info.index) seen.add(edges[k]!);
    }

    return seen.size;
  }

  /**
   * Nodes the selected node imports — its own `edges` array, deduped and
   * sorted by label.
   */
  @cached
  get outNeighbors(): NeighborEntry[] {
    const info = this.info;
    const g = this.graph.current;

    if (!info || !g) return [];

    const edges = g.edgesFlat;
    const seen = new Set<number>();
    const out: NeighborEntry[] = [];

    for (let k = 0; k < edges.length; k += 2) {
      if (edges[k] !== info.index) continue;

      const tgt = edges[k + 1]!;

      if (seen.has(tgt)) continue;
      seen.add(tgt);
      out.push({ id: g.ids[tgt]!, label: g.labels[tgt]! });
    }

    out.sort((a, b) => a.label.localeCompare(b.label));

    return out;
  }

  /** Deduped outgoing-neighbor count. See `inNeighborCount`. */
  @cached
  get outNeighborCount(): number {
    const info = this.info;
    const g = this.graph.current;

    if (!info || !g) return 0;

    const edges = g.edgesFlat;
    const seen = new Set<number>();

    for (let k = 0; k < edges.length; k += 2) {
      if (edges[k] === info.index) seen.add(edges[k + 1]!);
    }

    return seen.size;
  }

  /**
   * Cycles the selected node sits on. The top-level entries are the
   * bundled cycles (the same loops the renderer red-rings). Each one
   * also carries the underlying raw cycles that contract to it — handy
   * when packages are connected by lots of file-level imports and you
   * want to see which files actually closed the loop.
   *
   * Bundled cycles are deduped by canonical node sequence so parallel
   * raw edges (many `file → file` imports between two packages) don't
   * produce one bundled cycle per edge.
   */
  get cycles(): CycleEntry[] {
    const info = this.info;
    const g = this.graph.current;

    if (!info || !g) return [];

    // Cache key: every input that actually changes which cycles
    // appear or how they render. `collapsedHeaders` / `expandedRefs`
    // are deliberately *not* in the key — those are template-level
    // toggles and recomputing cycles when the user closes one cycle's
    // body is exactly what made this getter slow.
    const vs = this.viewState;
    const hiddenTypesKey = serializeIntSet(vs.hiddenNodeTypes);
    const hiddenEdgeTypesKey = serializeIntSet(vs.hiddenEdgeTypes);
    const collapsedKey = serializeStringSet(vs.collapsedIds);
    const hiddenIdsKey = serializeStringSet(vs.hiddenNodeIds);
    const globKey = `${vs.includeGlobs.join("|")}::${vs.excludeGlobs.join("|")}`;
    const cacheKey = `${info.index}|${hiddenTypesKey}|${hiddenEdgeTypesKey}|${collapsedKey}|${hiddenIdsKey}|${globKey}`;

    if (g === this.#lastGraph && cacheKey === this.#lastCycleKey) {
      return this.#lastEntries;
    }

    const radii = computeRadii(g.inDegree, g.outDegree);
    const contraction = buildContraction(
      g,
      radii,
      vs.hiddenNodeTypes,
      vs.collapsedIds,
      vs.effectiveHiddenNodeIds(g),
    );
    const remap = contraction?.nodeRemap ?? null;

    // Selected node is hidden — no bundled cycle goes through *this* node
    // (its loops are absorbed into the owner). Bail. Still cache the
    // empty result so subsequent reads with the same inputs skip the
    // contraction work.
    if (remap !== null && remap[info.index]! !== info.index) {
      // eslint-disable-next-line ember/no-side-effects
      this.#lastGraph = g;
      // eslint-disable-next-line ember/no-side-effects
      this.#lastCycleKey = cacheKey;
      // eslint-disable-next-line ember/no-side-effects
      this.#lastEntries = [];

      return this.#lastEntries;
    }

    // The exponential elementary-cycle enumeration runs once in the
    // resident Rust session (service-memoized by graph + edge-type
    // filter). While a fresh result is in flight, keep the previous
    // entries so the panel never blocks. The contraction/dedupe below
    // is the cheap synchronous pass on that fixed raw list.
    const rawPromise = this.visualizer.cycleRaw(Int32Array.from(vs.hiddenEdgeTypes), 1000);

    if (!rawPromise) return [];

    const rawCycles = getPromiseState(rawPromise).resolved;

    if (!rawCycles) return this.#lastEntries;

    // Bundled cycles: contracted, deduped by canonical sequence. Same
    // source the renderer uses for red rings, so the info-panel list
    // and the canvas can't disagree.
    const bundledCycles = bundleRawCyclesWithGroups(rawCycles, remap).filter((c) =>
      c.bundled.includes(info.index),
    );

    const entries: CycleEntry[] = [];

    for (const bundled of bundledCycles) {
      const bundledKey = canonicalCycleKey(bundled.bundled);
      const nodes: CycleNodeEntry[] = bundled.bundled.map((idx, i) => {
        const group = bundled.groups[i]!;
        // Only surface raw files that differ from the bundled rep —
        // with no contraction (remap === null) every raw === bundled
        // and `rawFiles` stays empty so the template renders the
        // unchanged single-line layout.
        const rawFiles: RawCycleFile[] = [];

        for (const rawIdx of group) {
          if (rawIdx === idx) continue;
          rawFiles.push({ id: g.ids[rawIdx]!, label: g.labels[rawIdx]! });
        }

        return { id: g.ids[idx]!, label: g.labels[idx]!, rawFiles };
      });

      entries.push({
        nodes,
        // `id`, `segments`, and `containedLabel` are filled in after
        // sorting — the canonical-cycle map needs the final shortest-
        // first order and the short ids derive from the canonical key.
        id: "",
        segments: [],
        containedLabel: "",
        key: bundledKey,
      });
    }

    // Shortest bundled cycles first (matches the floating panel's order).
    entries.sort((a, b) => a.nodes.length - b.nodes.length);

    // Assign each cycle its short, UUID-first-segment-style id
    // (deterministic from the canonical key). `usedIds` is the
    // collision-tracking Set that `shortCycleId` extends through if
    // two cycles hash to the same 8 hex chars.
    const usedIds = new Set<string>();

    for (const entry of entries) entry.id = shortCycleId(entry.key, usedIds);

    // Each node's canonical cycle id = the id of the smallest cycle
    // in this list that contains it. Single pass since entries are
    // already shortest-first.
    const canonical = new Map<string, string>();

    for (const entry of entries) {
      for (const node of entry.nodes) {
        if (!canonical.has(node.id)) canonical.set(node.id, entry.id);
      }
    }

    for (const entry of entries) {
      entry.segments = buildCycleSegments(entry.nodes, entry.id, canonical);
      entry.containedLabel = formatContainedLabel(entry.segments);
    }

    // eslint-disable-next-line ember/no-side-effects
    this.#lastGraph = g;
    // eslint-disable-next-line ember/no-side-effects
    this.#lastCycleKey = cacheKey;
    // eslint-disable-next-line ember/no-side-effects
    this.#lastEntries = entries;

    return entries;
  }

  get metaEntries(): { key: string; value: string }[] {
    const meta = this.info?.meta;

    if (meta === null || meta === undefined || typeof meta !== "object") return [];

    const out: { key: string; value: string }[] = [];

    for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
      let s: string;

      if (typeof v === "string") s = v;
      else if (typeof v === "number" || typeof v === "boolean") s = String(v);
      else s = JSON.stringify(v);
      out.push({ key: k, value: s });
    }

    return out;
  }

  /**
   * Default to open when the section is short enough to scan at a glance;
   * collapse otherwise so a node with hundreds of incoming edges doesn't
   * push the rest of the panel off-screen. Once the user manually
   * toggles a section their explicit choice is persisted in the URL
   * (see `viewState.infoInOpenOverride` etc.) and wins over the
   * auto-default; toggling back to the natural state clears the URL key
   * so the auto-default takes over again.
   */
  static readonly AUTO_OPEN_THRESHOLD = 20;

  /**
   * The auto-open heuristic is per-node (short lists open, long ones
   * collapse). Recomputing it on every selection made *untouched*
   * sections flip as the user clicked from node to node — collapse the
   * cycles section, click a cycle member to view it, and `in`/`out`
   * would spring open/closed under a different node's counts, so the
   * panel visibly jumped. Latch the first resolved default per section
   * for the panel's lifetime: navigation no longer reshuffles the
   * layout, while an explicit user toggle still persists through
   * `viewState` and always wins over the latch.
   */
  #autoOpenLatch: { in?: boolean; out?: boolean; cycles?: boolean } = {};

  private latchedOpen(
    key: "in" | "out" | "cycles",
    override: boolean | null,
    auto: () => boolean,
  ): boolean {
    if (override !== null) return override;

    let latched = this.#autoOpenLatch[key];

    if (latched === undefined) {
      latched = auto();
      this.#autoOpenLatch[key] = latched;
    }

    return latched;
  }

  get inOpen(): boolean {
    return this.latchedOpen(
      "in",
      this.viewState.infoInOpenOverride,
      () => this.inNeighborCount <= InfoPanel.AUTO_OPEN_THRESHOLD,
    );
  }

  get outOpen(): boolean {
    return this.latchedOpen(
      "out",
      this.viewState.infoOutOpenOverride,
      () => this.outNeighborCount <= InfoPanel.AUTO_OPEN_THRESHOLD,
    );
  }

  get cyclesOpen(): boolean {
    return this.latchedOpen(
      "cycles",
      this.viewState.infoCyclesOpenOverride,
      () => this.cycles.length <= InfoPanel.AUTO_OPEN_THRESHOLD,
    );
  }

  /**
   * `<summary>` click handler. The browser would normally toggle the
   * parent `<details>` for us — we preventDefault and run the toggle
   * through `viewState` instead so the new open state lands in the URL
   * and the next page load (or shared link) picks it up.
   *
   * The user's pick is *always* sticky — we never collapse a freshly-
   * set override back to `null` just because it matches the
   * auto-default for the currently-selected node. Two different
   * selections produce two different auto-defaults (the threshold is
   * per-neighbor-count), so an explicit close on a long-list node
   * would otherwise quietly reopen the next time the user selected a
   * short-list node. Storing the user's choice verbatim keeps section
   * state from springing back open as they click around.
   */
  @action
  toggleIn(event: MouseEvent): void {
    event.preventDefault();
    this.viewState.infoInOpenOverride = !this.inOpen;
  }

  @action
  toggleOut(event: MouseEvent): void {
    event.preventDefault();
    this.viewState.infoOutOpenOverride = !this.outOpen;
  }

  @action
  toggleCycles(event: MouseEvent): void {
    event.preventDefault();
    this.viewState.infoCyclesOpenOverride = !this.cyclesOpen;
  }

  @action
  close(): void {
    this.viewState.selectedId = null;
  }

  // ---- drag + resize ----

  setupDrag = createDragModifier({
    panelSelector: ".info-panel",
    set: (g) => {
      this.viewState.infoPanelGeometry = g;
    },
  });

  applyGeometry = createApplyGeometryModifier({
    getInitial: () => this.viewState.infoPanelGeometry,
    registerReset: (cb) => this.viewState.registerGeometryReset(cb),
  });

  #setGeometry = (g: PanelGeometry): void => {
    this.viewState.infoPanelGeometry = g;
  };

  resizeN = createResizeModifier({
    panelSelector: ".info-panel",
    edge: "n",
    set: this.#setGeometry,
  });
  resizeS = createResizeModifier({
    panelSelector: ".info-panel",
    edge: "s",
    set: this.#setGeometry,
  });
  resizeE = createResizeModifier({
    panelSelector: ".info-panel",
    edge: "e",
    set: this.#setGeometry,
  });
  resizeW = createResizeModifier({
    panelSelector: ".info-panel",
    edge: "w",
    set: this.#setGeometry,
  });
  resizeNW = createResizeModifier({
    panelSelector: ".info-panel",
    edge: "nw",
    set: this.#setGeometry,
  });
  resizeNE = createResizeModifier({
    panelSelector: ".info-panel",
    edge: "ne",
    set: this.#setGeometry,
  });
  resizeSW = createResizeModifier({
    panelSelector: ".info-panel",
    edge: "sw",
    set: this.#setGeometry,
  });
  resizeSE = createResizeModifier({
    panelSelector: ".info-panel",
    edge: "se",
    set: this.#setGeometry,
  });

  @action
  selectNeighbor(id: string): void {
    this.viewState.selectedId = id;
  }

  /**
   * Mirror the row's hover state into the visualizer service so the
   * Visualizer's rAF loop can grow the corresponding node on the canvas
   * (same flag the on-canvas mouse hover sets).
   */
  @action
  hoverNeighbor(id: string): void {
    this.visualizer.externalHoverId = id;
  }

  @action
  unhoverNeighbor(): void {
    this.visualizer.externalHoverId = null;
  }

  /**
   * Hide the currently selected node from the graph + cycle detection.
   * The node's id joins the `hiddenNodes` URL list; the selection is
   * cleared so the panel collapses (otherwise it would dangle on an
   * invisible node).
   */
  @action
  hideSelected(): void {
    const id = this.info?.id;

    if (!id) return;
    this.viewState.toggleHiddenNodeId(id);
    this.viewState.selectedId = null;
  }

  <template>
    {{#if this.info}}
      <aside class="panel info-panel" {{this.applyGeometry}}>
        <div class="panel__head" {{this.setupDrag}}>
          <h2 class="panel__title">{{this.info.label}}</h2>
          <button
            type="button"
            class="panel__close"
            {{on "click" this.close}}
            aria-label="Close"
          ><IconX /></button>
        </div>
        <div class="panel__body">
          <p class="panel__id">id: <code>{{this.info.id}}</code></p>
          {{#if this.info.type}}
            <dl class="panel__stats">
              <dt>type</dt><dd>{{this.info.type}}</dd>
            </dl>
          {{/if}}

          <p class="panel__actions">
            <button
              type="button"
              class="panel__action"
              {{on "click" this.hideSelected}}
              title="Drop this node from the graph and cycle detection. Show it again from the controls panel."
            >Hide node</button>
          </p>

          <details class="panel__section" open={{this.inOpen}}>
            <summary class="panel__subhead" {{on "click" this.toggleIn}}><IconCaretRight
                class="summary-caret"
              />in ({{this.inNeighborCount}})</summary>
            {{#if this.inNeighborCount}}
              {{#if this.inOpen}}
                <ul class="panel__neighbors">
                  {{#each this.inNeighbors as |entry|}}
                    <li>
                      <button
                        type="button"
                        class="panel__neighbor"
                        title={{entry.id}}
                        {{on "click" (fn this.selectNeighbor entry.id)}}
                        {{on "mouseenter" (fn this.hoverNeighbor entry.id)}}
                        {{on "mouseleave" this.unhoverNeighbor}}
                      >
                        <span class="panel__neighbor-label">{{entry.label}}</span>
                        <code class="panel__neighbor-id">{{entry.id}}</code>
                      </button>
                    </li>
                  {{/each}}
                </ul>
              {{/if}}
            {{else}}
              <p class="panel__empty">No incoming edges.</p>
            {{/if}}
          </details>

          <details class="panel__section" open={{this.outOpen}}>
            <summary class="panel__subhead" {{on "click" this.toggleOut}}><IconCaretRight
                class="summary-caret"
              />out ({{this.outNeighborCount}})</summary>
            {{#if this.outNeighborCount}}
              {{#if this.outOpen}}
                <ul class="panel__neighbors">
                  {{#each this.outNeighbors as |entry|}}
                    <li>
                      <button
                        type="button"
                        class="panel__neighbor"
                        title={{entry.id}}
                        {{on "click" (fn this.selectNeighbor entry.id)}}
                        {{on "mouseenter" (fn this.hoverNeighbor entry.id)}}
                        {{on "mouseleave" this.unhoverNeighbor}}
                      >
                        <span class="panel__neighbor-label">{{entry.label}}</span>
                        <code class="panel__neighbor-id">{{entry.id}}</code>
                      </button>
                    </li>
                  {{/each}}
                </ul>
              {{/if}}
            {{else}}
              <p class="panel__empty">No outgoing edges.</p>
            {{/if}}
          </details>

          <details class="panel__section" open={{this.cyclesOpen}}>
            <summary class="panel__subhead" {{on "click" this.toggleCycles}}>
              <IconCaretRight class="summary-caret" />
              <span>cycles ({{this.cycles.length}})</span>
              {{#if this.cycles.length}}
                <button
                  type="button"
                  class="panel__subhead-action"
                  {{on "click" this.toggleAllCycles}}
                  title="Collapse or expand every cycle's body in one go"
                >{{if this.allCyclesCollapsed "Expand all" "Collapse all"}}</button>
              {{/if}}
            </summary>
            {{#if this.topReferencedCycles.length}}
              <div class="panel__top-cycles">
                <div class="panel__top-cycles-label">most referenced</div>
                <ol class="panel__cycles">
                  {{#each this.topReferencedCycles key="entry.id" as |ref|}}
                    <li class="panel__cycle">
                      <button
                        type="button"
                        class="panel__cycle-head
                          {{if (isExpanded this.expandedTopHeaders ref.entry.id) 'is-expanded'}}"
                        {{on "click" (fn this.toggleTopHeader ref.entry.id)}}
                        aria-expanded={{if
                          (isExpanded this.expandedTopHeaders ref.entry.id)
                          "true"
                          "false"
                        }}
                        title="Referenced by {{ref.count}} other cycle{{if (neq ref.count 1) 's'}}"
                      >
                        <span class="panel__cycle-head-text">referenced by
                          {{ref.count}}{{if (neq ref.count 1) " cycles" " cycle"}}
                          ·
                          {{ref.entry.nodes.length}}
                          nodes</span>
                        <code class="cycle-id">{{ref.entry.id}}</code>
                      </button>
                      {{#if (isExpanded this.expandedTopHeaders ref.entry.id)}}
                        <ol class="panel__neighbors panel__neighbors--ordered">
                          {{#each ref.entry.segments key="key" as |seg|}}
                            {{#unless seg.cycleId}}
                              {{#each seg.nodes key="index" as |entry|}}
                                <li>
                                  <span class="panel__neighbor-index">{{entry.index}}.</span>
                                  <button
                                    type="button"
                                    class="panel__neighbor"
                                    title={{entry.node.id}}
                                    {{on "click" (fn this.selectNeighbor entry.node.id)}}
                                    {{on "mouseenter" (fn this.hoverNeighbor entry.node.id)}}
                                    {{on "mouseleave" this.unhoverNeighbor}}
                                  >
                                    <span class="panel__neighbor-label">{{entry.node.label}}</span>
                                    {{#if (neq entry.node.id entry.node.label)}}
                                      <code class="panel__neighbor-id">{{entry.node.id}}</code>
                                    {{/if}}
                                    {{#if entry.node.rawFiles.length}}
                                      <span class="panel__neighbor-raw">
                                        {{#each entry.node.rawFiles key="id" as |file index|}}
                                          {{#if index}}<IconArrowRight
                                            />{{else}}<IconArrowElbowDownRight />{{/if}}
                                          {{file.label}}
                                        {{/each}}
                                      </span>
                                    {{/if}}
                                  </button>
                                </li>
                              {{/each}}
                            {{/unless}}
                            {{#if seg.cycleId}}
                              <li>
                                <button
                                  type="button"
                                  class="cycle-ref"
                                  {{on "click" (fn this.toggleCycleRef seg.key)}}
                                  aria-expanded={{if
                                    (isExpanded this.expandedRefs seg.key)
                                    "true"
                                    "false"
                                  }}
                                  title="Toggle which nodes here belong to cycle {{seg.cycleId}}"
                                >
                                  <span class="cycle-ref__label">
                                    … ({{seg.nodes.length}}) — click to expand …
                                  </span>
                                  <code class="cycle-id">{{seg.cycleId}}</code>
                                </button>
                                {{#if (isExpanded this.expandedRefs seg.key)}}
                                  <ol
                                    class="panel__neighbors panel__neighbors--ordered panel__neighbors--nested"
                                  >
                                    {{#each seg.nodes key="index" as |entry|}}
                                      <li>
                                        <span class="panel__neighbor-index">{{entry.index}}.</span>
                                        <button
                                          type="button"
                                          class="panel__neighbor"
                                          title={{entry.node.id}}
                                          {{on "click" (fn this.selectNeighbor entry.node.id)}}
                                          {{on "mouseenter" (fn this.hoverNeighbor entry.node.id)}}
                                          {{on "mouseleave" this.unhoverNeighbor}}
                                        >
                                          <span
                                            class="panel__neighbor-label"
                                          >{{entry.node.label}}</span>
                                          {{#if (neq entry.node.id entry.node.label)}}
                                            <code
                                              class="panel__neighbor-id"
                                            >{{entry.node.id}}</code>
                                          {{/if}}
                                          {{#if entry.node.rawFiles.length}}
                                            <span class="panel__neighbor-raw">
                                              {{#each entry.node.rawFiles key="id" as |file index|}}
                                                {{#if index}}<IconArrowRight
                                                  />{{else}}<IconArrowElbowDownRight />{{/if}}
                                                {{file.label}}
                                              {{/each}}
                                            </span>
                                          {{/if}}
                                        </button>
                                      </li>
                                    {{/each}}
                                  </ol>
                                {{/if}}
                              </li>
                            {{/if}}
                          {{/each}}
                        </ol>
                      {{/if}}
                    </li>
                  {{/each}}
                </ol>
              </div>
            {{/if}}
            {{#if this.cycles.length}}
              <ol class="panel__cycles">
                {{#each this.cycles key="key" as |cycle|}}
                  <li class="panel__cycle">
                    <button
                      type="button"
                      class="panel__cycle-head
                        {{unless (isExpanded this.collapsedHeaders cycle.key) 'is-expanded'}}"
                      {{on "click" (fn this.toggleCycleHeader cycle.key)}}
                      aria-expanded={{unless
                        (isExpanded this.collapsedHeaders cycle.key)
                        "true"
                        "false"
                      }}
                    >
                      <span class="panel__cycle-head-text">{{cycle.nodes.length}}
                        nodes{{#if cycle.containedLabel}}
                          · contains
                          {{cycle.containedLabel}}{{/if}}</span>
                      <code class="cycle-id">{{cycle.id}}</code>
                    </button>
                    {{#unless (isExpanded this.collapsedHeaders cycle.key)}}
                      <ol class="panel__neighbors panel__neighbors--ordered">
                        {{#each cycle.segments key="key" as |seg|}}
                          {{#unless seg.cycleId}}
                            {{#each seg.nodes key="index" as |entry|}}
                              <li>
                                <span class="panel__neighbor-index">{{entry.index}}.</span>
                                <button
                                  type="button"
                                  class="panel__neighbor"
                                  title={{entry.node.id}}
                                  {{on "click" (fn this.selectNeighbor entry.node.id)}}
                                  {{on "mouseenter" (fn this.hoverNeighbor entry.node.id)}}
                                  {{on "mouseleave" this.unhoverNeighbor}}
                                >
                                  <span class="panel__neighbor-label">{{entry.node.label}}</span>
                                  {{#if (neq entry.node.id entry.node.label)}}
                                    <code class="panel__neighbor-id">{{entry.node.id}}</code>
                                  {{/if}}
                                  {{#if entry.node.rawFiles.length}}
                                    <span class="panel__neighbor-raw">
                                      {{#each entry.node.rawFiles key="id" as |file index|}}
                                        {{#if index}}<IconArrowRight
                                          />{{else}}<IconArrowElbowDownRight />{{/if}}
                                        {{file.label}}
                                      {{/each}}
                                    </span>
                                  {{/if}}
                                </button>
                              </li>
                            {{/each}}
                          {{/unless}}
                          {{#if seg.cycleId}}
                            <li>
                              <button
                                type="button"
                                class="cycle-ref"
                                {{on "click" (fn this.toggleCycleRef seg.key)}}
                                aria-expanded={{if
                                  (isExpanded this.expandedRefs seg.key)
                                  "true"
                                  "false"
                                }}
                                title="Toggle which nodes here belong to cycle {{seg.cycleId}}"
                              >
                                <span class="cycle-ref__label">
                                  … ({{seg.nodes.length}}) — click to expand …
                                </span>
                                <code class="cycle-id">{{seg.cycleId}}</code>
                              </button>
                              {{#if (isExpanded this.expandedRefs seg.key)}}
                                <ol
                                  class="panel__neighbors panel__neighbors--ordered panel__neighbors--nested"
                                >
                                  {{#each seg.nodes key="index" as |entry|}}
                                    <li>
                                      <span class="panel__neighbor-index">{{entry.index}}.</span>
                                      <button
                                        type="button"
                                        class="panel__neighbor"
                                        title={{entry.node.id}}
                                        {{on "click" (fn this.selectNeighbor entry.node.id)}}
                                        {{on "mouseenter" (fn this.hoverNeighbor entry.node.id)}}
                                        {{on "mouseleave" this.unhoverNeighbor}}
                                      >
                                        <span
                                          class="panel__neighbor-label"
                                        >{{entry.node.label}}</span>
                                        {{#if (neq entry.node.id entry.node.label)}}
                                          <code class="panel__neighbor-id">{{entry.node.id}}</code>
                                        {{/if}}
                                        {{#if entry.node.rawFiles.length}}
                                          <span class="panel__neighbor-raw">
                                            {{#each entry.node.rawFiles key="id" as |file index|}}
                                              {{#if index}}<IconArrowRight
                                                />{{else}}<IconArrowElbowDownRight />{{/if}}
                                              {{file.label}}
                                            {{/each}}
                                          </span>
                                        {{/if}}
                                      </button>
                                    </li>
                                  {{/each}}
                                </ol>
                              {{/if}}
                            </li>
                          {{/if}}
                        {{/each}}
                      </ol>
                    {{/unless}}
                  </li>
                {{/each}}
              </ol>
            {{else}}
              <p class="panel__empty">Not part of a cycle.</p>
            {{/if}}
          </details>

          {{#if this.metaEntries.length}}
            <h3 class="panel__subhead">meta</h3>
            <dl class="panel__meta">
              {{#each this.metaEntries as |entry|}}
                <dt>{{entry.key}}</dt><dd>{{entry.value}}</dd>
              {{/each}}
            </dl>
          {{/if}}
        </div>
        <div class="panel__resize-handle panel__resize-handle--n" {{this.resizeN}}></div>
        <div class="panel__resize-handle panel__resize-handle--s" {{this.resizeS}}></div>
        <div class="panel__resize-handle panel__resize-handle--e" {{this.resizeE}}></div>
        <div class="panel__resize-handle panel__resize-handle--w" {{this.resizeW}}></div>
        <div class="panel__resize-handle panel__resize-handle--nw" {{this.resizeNW}}></div>
        <div class="panel__resize-handle panel__resize-handle--ne" {{this.resizeNE}}></div>
        <div class="panel__resize-handle panel__resize-handle--sw" {{this.resizeSW}}></div>
        <div class="panel__resize-handle panel__resize-handle--se" {{this.resizeSE}}></div>
      </aside>
    {{/if}}
  </template>
}

/**
 * Count the distinct ref-cycle ids in a cycle's segments and format
 * as `"1 cycle"` / `"5 cycles"`. Returns `""` when the cycle has no
 * ref segments. Matches `formatContainedLabel` in `cycles-panel.gts`.
 */
function formatContainedLabel(segments: CycleSegment[]): string {
  const seen = new Set<string>();

  for (const seg of segments) {
    if (seg.cycleId !== undefined) seen.add(seg.cycleId);
  }

  if (seen.size === 0) return "";

  return `${seen.size} cycle${seen.size === 1 ? "" : "s"}`;
}

/**
 * Group a cycle's nodes into `own` / `ref` segments using the
 * canonical-cycle map. Same algorithm as the matching helper in
 * `cycles-panel.gts` — kept local here because the info-panel's nodes
 * carry their 1-based position alongside the `NeighborEntry`.
 */
function buildCycleSegments(
  nodes: CycleNodeEntry[],
  cycleId: string,
  canonical: Map<string, string>,
): CycleSegment[] {
  const out: CycleSegment[] = [];
  let current: CycleSegment | null = null;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const indexedNode: DisplayedCycleNode = { index: i + 1, node };
    const nodeCanonical = canonical.get(node.id) ?? cycleId;
    const targetCycleId = nodeCanonical === cycleId ? undefined : nodeCanonical;

    if (current === null || current.cycleId !== targetCycleId) {
      const key = `${cycleId}-${out.length}`;

      current = { key, cycleId: targetCycleId, nodes: [indexedNode] };
      out.push(current);
    } else {
      current.nodes.push(indexedNode);
    }
  }

  return out;
}

function isExpanded(set: Set<string>, key: string): boolean {
  return set.has(key);
}

function serializeIntSet(set: Set<number>): string {
  if (set.size === 0) return "";

  return [...set].sort((a, b) => a - b).join(",");
}

function serializeStringSet(set: Set<string>): string {
  if (set.size === 0) return "";

  return [...set].sort().join(",");
}
