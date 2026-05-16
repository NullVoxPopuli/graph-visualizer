import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { fn } from "@ember/helper";
import { on } from "@ember/modifier";
import { action } from "@ember/object";
import { service } from "@ember/service";

import { type Collapsed, collapseList, toggleInSet } from "#lib/collapse-list";
import { buildContraction } from "#lib/contract";
import {
  bundleRawCycles,
  canonicalCycleKey,
  contractCycle as sharedContractCycle,
  findAllCycles,
} from "#lib/cycle";
import {
  createApplyGeometryModifier,
  createDragModifier,
  createResizeModifier,
} from "#lib/floating-panel";
import { computeRadii } from "#lib/pack";

import type { PanelGeometry } from "#lib/floating-panel";
import type GraphService from "#services/graph";
import type ViewStateService from "#services/view-state";
import type VisualizerService from "#services/visualizer";

interface NeighborEntry {
  id: string;
  label: string;
}

interface OccurrenceEntry extends NeighborEntry {
  /** How many of this bundled cycle's underlying raw cycles include this node. */
  count: number;
}

interface DisplayedCycleNode {
  /** 1-based position in the bundled cycle. */
  index: number;
  node: NeighborEntry;
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
  cycleId?: number;
}

interface CycleEntry {
  /** Bundled cycle — the visible reps the canvas red-rings. */
  nodes: NeighborEntry[];
  /** 1-based, shortest-first index. Stable for a given selection. */
  id: number;
  segments: CycleSegment[];
  /**
   * Same `head / hiddenCount / tail` collapse applied to the per-node
   * occurrence counts. Empty `head` (and zero `hiddenCount`) when no
   * contraction is active.
   */
  occList: Collapsed<OccurrenceEntry>;
  /**
   * Full raw occurrence list — kept so the template can show the
   * occurrence count in the section header even when the list is
   * collapsed.
   */
  occurrencesLength: number;
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

export default class InfoPanel extends Component {
  @service declare viewState: ViewStateService;
  @service declare graph: GraphService;
  @service declare visualizer: VisualizerService;

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
   * Same `head / hiddenCount / tail` collapse-expand state for the
   * occurrences table inside each cycle. Independent of the cycle's
   * own node list, which now uses segment refs instead of a hidden
   * marker.
   */
  @tracked private expandedOccLists: Set<string> = new Set();

  @action
  toggleCycleHeader(key: string): void {
    this.collapsedHeaders = toggleInSet(this.collapsedHeaders, key);
  }

  @action
  toggleCycleRef(segKey: string): void {
    this.expandedRefs = toggleInSet(this.expandedRefs, segKey);
  }

  @action
  toggleCycleOccList(key: string): void {
    this.expandedOccLists = toggleInSet(this.expandedOccLists, key);
  }

  /**
   * Resolve the URL-encoded selected id to a typed SelectedInfo from the
   * loaded graph. Returns null when nothing's selected, no graph is loaded,
   * or the id isn't in the graph (e.g., stale URL after the user dropped a
   * different file).
   */
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
   * Nodes the selected node imports — its own `edges` array, deduped and
   * sorted by label.
   */
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

    const radii = computeRadii(g.inDegree, g.outDegree);
    const contraction = buildContraction(
      g,
      radii,
      this.viewState.hiddenNodeTypes,
      this.viewState.collapsedIds,
      this.viewState.hiddenNodeIds,
    );
    const remap = contraction?.nodeRemap ?? null;

    // Selected node is hidden — no bundled cycle goes through *this* node
    // (its loops are absorbed into the owner). Bail.
    if (remap !== null && remap[info.index]! !== info.index) return [];

    // Raw cycles power both the bundled list (after contraction +
    // dedupe) and the per-node occurrence counts, so we enumerate them
    // once and reuse — `findAllCycles` is the exponential step and
    // running it twice on a large graph is what previously made
    // selecting a node feel slow.
    const rawCycles = findAllCycles(g, null);
    // Bundled cycles: contracted, deduped by canonical sequence. Same
    // source the renderer uses for red rings, so the info-panel list
    // and the canvas can't disagree.
    const bundledCycles = bundleRawCycles(rawCycles, remap).filter((c) => c.includes(info.index));

    // Pre-index raw cycles by their bundled canonical key so each
    // bundled cycle can grab its matching raw cycles in one lookup.
    const rawsByBundle = new Map<string, number[][]>();

    for (const r of rawCycles) {
      const bundled = sharedContractCycle(r, remap);

      if (bundled === null) continue;

      const key = canonicalCycleKey(bundled);
      let arr = rawsByBundle.get(key);

      if (!arr) {
        arr = [];
        rawsByBundle.set(key, arr);
      }

      arr.push(r);
    }

    const entries: CycleEntry[] = [];

    for (const bundled of bundledCycles) {
      const bundledKey = canonicalCycleKey(bundled);
      const raws = rawsByBundle.get(bundledKey) ?? [];
      const nodes = bundled.map((idx) => ({
        id: g.ids[idx]!,
        label: g.labels[idx]!,
      }));
      // Aggregate raw node participation across every raw cycle that
      // contracts to this bundled one. Skip when nothing is hidden —
      // the bundled list already shows the same nodes.
      const occurrences: OccurrenceEntry[] = [];

      if (remap !== null) {
        const counts = new Map<number, number>();

        for (const rc of raws) {
          // Each node in a raw cycle is counted at most once per raw
          // cycle — we want "this raw node appears in N of the
          // underlying loops," not "this raw node is visited N times
          // across all loops."
          const seenInThisCycle = new Set<number>();

          for (const idx of rc) {
            if (seenInThisCycle.has(idx)) continue;
            seenInThisCycle.add(idx);
            counts.set(idx, (counts.get(idx) ?? 0) + 1);
          }
        }

        for (const [idx, count] of counts) {
          occurrences.push({
            id: g.ids[idx]!,
            label: g.labels[idx]!,
            count,
          });
        }

        // High-count first; ties broken alphabetically so the list is
        // stable across renders.
        occurrences.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
      }

      entries.push({
        nodes,
        // `id` and `segments` are filled in after sorting — the
        // canonical-cycle map needs the final shortest-first order.
        id: 0,
        segments: [],
        occList: collapseList(occurrences, this.expandedOccLists.has(bundledKey)),
        occurrencesLength: occurrences.length,
        key: bundledKey,
      });
    }

    // Shortest bundled cycles first (matches the floating panel's order).
    entries.sort((a, b) => a.nodes.length - b.nodes.length);

    // Each node's canonical cycle = the smallest cycle in this list
    // that contains it. With entries sorted shortest-first, the first
    // cycle a node appears in *is* that canonical, so a single pass
    // here builds the map without checking sizes.
    const canonical = new Map<string, number>();

    for (let i = 0; i < entries.length; i++) {
      const cycleId = i + 1;

      for (const node of entries[i]!.nodes) {
        if (!canonical.has(node.id)) canonical.set(node.id, cycleId);
      }
    }

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;

      entry.id = i + 1;
      entry.segments = buildCycleSegments(entry.nodes, entry.id, canonical);
    }

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

  get inOpen(): boolean {
    const override = this.viewState.infoInOpenOverride;

    if (override !== null) return override;

    return this.inNeighbors.length <= InfoPanel.AUTO_OPEN_THRESHOLD;
  }

  get outOpen(): boolean {
    const override = this.viewState.infoOutOpenOverride;

    if (override !== null) return override;

    return this.outNeighbors.length <= InfoPanel.AUTO_OPEN_THRESHOLD;
  }

  get cyclesOpen(): boolean {
    const override = this.viewState.infoCyclesOpenOverride;

    if (override !== null) return override;

    return this.cycles.length <= InfoPanel.AUTO_OPEN_THRESHOLD;
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
          >×</button>
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
            <summary class="panel__subhead" {{on "click" this.toggleIn}}>in ({{this.inNeighbors.length}})</summary>
            {{#if this.inNeighbors.length}}
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
            {{else}}
              <p class="panel__empty">No incoming edges.</p>
            {{/if}}
          </details>

          <details class="panel__section" open={{this.outOpen}}>
            <summary class="panel__subhead" {{on "click" this.toggleOut}}>out ({{this.outNeighbors.length}})</summary>
            {{#if this.outNeighbors.length}}
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
            {{else}}
              <p class="panel__empty">No outgoing edges.</p>
            {{/if}}
          </details>

          <details class="panel__section" open={{this.cyclesOpen}}>
            <summary class="panel__subhead" {{on "click" this.toggleCycles}}>cycles ({{this.cycles.length}})</summary>
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
                    >cycle#{{cycle.id}}{{#unless (isExpanded this.collapsedHeaders cycle.key)}}
                        ·
                        {{cycle.nodes.length}}
                        nodes{{/unless}}</button>
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
                                  {{#if (notEq entry.node.id entry.node.label)}}
                                    <code class="panel__neighbor-id">{{entry.node.id}}</code>
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
                                title="Toggle which nodes here belong to cycle#{{seg.cycleId}}"
                              >
                                … cycle#{{seg.cycleId}}
                                ({{seg.nodes.length}}) — click to expand …
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
                                        {{#if (notEq entry.node.id entry.node.label)}}
                                          <code class="panel__neighbor-id">{{entry.node.id}}</code>
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
                      {{#if cycle.occurrencesLength}}
                        <div class="panel__cycle-raws">
                          <div class="panel__cycle-raws-head">occurrences in a cycle</div>
                          <table class="panel__occurrence-table">
                            <thead>
                              <tr>
                                <th scope="col">node</th>
                                <th scope="col" class="panel__occurrence-count-col">in</th>
                              </tr>
                            </thead>
                            <tbody>
                              {{#each cycle.occList.head key="id" as |entry|}}
                                <tr>
                                  <td>
                                    <button
                                      type="button"
                                      class="panel__occurrence-link"
                                      title={{entry.id}}
                                      {{on "click" (fn this.selectNeighbor entry.id)}}
                                      {{on "mouseenter" (fn this.hoverNeighbor entry.id)}}
                                      {{on "mouseleave" this.unhoverNeighbor}}
                                    >{{entry.label}}</button>
                                  </td>
                                  <td class="panel__occurrence-count-col">{{entry.count}}</td>
                                </tr>
                              {{/each}}
                              {{#if cycle.occList.hiddenCount}}
                                <tr>
                                  <td colspan="2">
                                    <button
                                      type="button"
                                      class="cycle-hidden"
                                      title="Show all {{cycle.occurrencesLength}} occurrences"
                                      {{on "click" (fn this.toggleCycleOccList cycle.key)}}
                                    >…
                                      {{cycle.occList.hiddenCount}}
                                      hidden — click to expand</button>
                                  </td>
                                </tr>
                              {{/if}}
                              {{#each cycle.occList.tail key="id" as |entry|}}
                                <tr>
                                  <td>
                                    <button
                                      type="button"
                                      class="panel__occurrence-link"
                                      title={{entry.id}}
                                      {{on "click" (fn this.selectNeighbor entry.id)}}
                                      {{on "mouseenter" (fn this.hoverNeighbor entry.id)}}
                                      {{on "mouseleave" this.unhoverNeighbor}}
                                    >{{entry.label}}</button>
                                  </td>
                                  <td class="panel__occurrence-count-col">{{entry.count}}</td>
                                </tr>
                              {{/each}}
                              {{#if
                                (and
                                  (isExpanded this.expandedOccLists cycle.key)
                                  (gt cycle.occurrencesLength 5)
                                )
                              }}
                                <tr>
                                  <td colspan="2">
                                    <button
                                      type="button"
                                      class="cycle-hidden"
                                      title="Collapse the occurrence list"
                                      {{on "click" (fn this.toggleCycleOccList cycle.key)}}
                                    >show less</button>
                                  </td>
                                </tr>
                              {{/if}}
                            </tbody>
                          </table>
                        </div>
                      {{/if}}
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
 * Group a cycle's nodes into `own` / `ref` segments using the
 * canonical-cycle map. Same algorithm as the matching helper in
 * `cycles-panel.gts` — kept local here because the info-panel's nodes
 * carry their 1-based position alongside the `NeighborEntry`.
 */
function buildCycleSegments(
  nodes: NeighborEntry[],
  cycleId: number,
  canonical: Map<string, number>,
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

function notEq(a: unknown, b: unknown): boolean {
  return a !== b;
}

function and(a: unknown, b: unknown): unknown {
  return a && b;
}

function gt(a: number, b: number): boolean {
  return a > b;
}

function isExpanded(set: Set<string>, key: string): boolean {
  return set.has(key);
}
