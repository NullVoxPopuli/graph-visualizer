import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { fn } from "@ember/helper";
import { on } from "@ember/modifier";
import { action } from "@ember/object";
import { service } from "@ember/service";

import { buildContraction } from "#lib/contract";
import {
  bundleRawCycles,
  canonicalCycleKey,
  contractCycle as sharedContractCycle,
  findAllCycles,
  hasAnyCycle,
} from "#lib/cycle";
import {
  createApplyGeometryModifier,
  createDragModifier,
  createSizeObserverModifier,
} from "#lib/floating-panel";
import { computeRadii } from "#lib/pack";

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

interface Collapsed<T> {
  head: T[];
  /** When > 0, render a "… N hidden …" marker between head and tail. */
  hiddenCount: number;
  tail: T[];
}

interface CycleEntry {
  /** Bundled cycle — the visible reps the canvas red-rings. */
  nodes: NeighborEntry[];
  /**
   * Long cycles are rendered as `head … hidden … tail` so a 22-node
   * loop doesn't take 22 rows. `head` is the first couple of nodes,
   * `tail` is the closing node, and `hiddenCount` is the number of
   * nodes hidden between them. When the user has expanded this cycle
   * `head` holds the full list and `hiddenCount`/`tail` are empty.
   */
  cycleList: Collapsed<DisplayedCycleNode>;
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

/**
 * Collapse `items` to `head + hidden marker + tail` so a long list
 * renders as four rows. When `expanded` is true we bypass the collapse
 * and put everything in `head` — the user clicked the marker to see
 * the full list. Lists of 5 or fewer rows are never collapsed (the
 * marker would save at most one row and just hide context).
 */
function collapseList<T>(items: T[], expanded: boolean): Collapsed<T> {
  if (expanded || items.length <= 5) {
    return { head: items, hiddenCount: 0, tail: [] };
  }

  const last = items.length - 1;

  return {
    head: [items[0]!, items[1]!],
    hiddenCount: items.length - 3,
    tail: [items[last]!],
  };
}

/**
 * Toggle membership of `key` in `set`, returning a fresh `Set` so the
 * `@tracked` slot detects the change.
 */
function toggleInSet(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);

  if (next.has(key)) next.delete(key);
  else next.add(key);

  return next;
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
   * Set of `cycle.key`s whose node list is currently expanded. Tracked
   * by replacing the Set so Glimmer picks up the change. State is
   * intentionally per-component: a new selection rebuilds the cycle
   * list with the same key set, so expansion choices persist across
   * selections of the same node but reset when the panel is torn down.
   */
  @tracked private expandedNodeLists: Set<string> = new Set();
  @tracked private expandedOccLists: Set<string> = new Set();

  @action
  toggleCycleNodeList(key: string): void {
    this.expandedNodeLists = toggleInSet(this.expandedNodeLists, key);
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

      const indexedNodes: DisplayedCycleNode[] = nodes.map((node, i) => ({
        index: i + 1,
        node,
      }));

      entries.push({
        nodes,
        cycleList: collapseList(indexedNodes, this.expandedNodeLists.has(bundledKey)),
        occList: collapseList(occurrences, this.expandedOccLists.has(bundledKey)),
        occurrencesLength: occurrences.length,
        key: bundledKey,
      });
    }

    // Shortest bundled cycles first (matches the floating panel's order).
    entries.sort((a, b) => a.nodes.length - b.nodes.length);

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
   * Whether the *graph as a whole* contains any cycle. Uses the fast
   * back-edge DFS in `hasAnyCycle` — it returns at the very first back
   * edge rather than building CSR + running full Tarjan the way
   * `findAllCycles` does. Drives the "There are no cycles" / "There is
   * at least one cycle" footer line; the existing per-node cycles list
   * only describes the selected node, which can read "no cycles" even
   * when the rest of the graph has plenty.
   */
  get hasAnyCycles(): boolean {
    const g = this.graph.current;

    if (!g) return false;

    return hasAnyCycle(g);
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
   * and the next page load (or shared link) picks it up. When the new
   * state happens to match what the auto-default would have picked the
   * override is cleared, keeping URLs free of redundant noise.
   */
  @action
  toggleIn(event: MouseEvent): void {
    event.preventDefault();

    const willOpen = !this.inOpen;
    const autoOpen = this.inNeighbors.length <= InfoPanel.AUTO_OPEN_THRESHOLD;

    this.viewState.infoInOpenOverride = willOpen === autoOpen ? null : willOpen;
  }

  @action
  toggleOut(event: MouseEvent): void {
    event.preventDefault();

    const willOpen = !this.outOpen;
    const autoOpen = this.outNeighbors.length <= InfoPanel.AUTO_OPEN_THRESHOLD;

    this.viewState.infoOutOpenOverride = willOpen === autoOpen ? null : willOpen;
  }

  @action
  toggleCycles(event: MouseEvent): void {
    event.preventDefault();

    const willOpen = !this.cyclesOpen;
    const autoOpen = this.cycles.length <= InfoPanel.AUTO_OPEN_THRESHOLD;

    this.viewState.infoCyclesOpenOverride = willOpen === autoOpen ? null : willOpen;
  }

  @action
  close(): void {
    this.viewState.selectedId = null;
  }

  // ---- drag + resize ----

  setupDrag = createDragModifier({
    panelSelector: ".panel",
    get: () => this.viewState.infoPanelGeometry,
    set: (g) => {
      this.viewState.infoPanelGeometry = g;
    },
  });

  applyGeometry = createApplyGeometryModifier(() => this.viewState.infoPanelGeometry);

  observePanelSize = createSizeObserverModifier(
    () => this.viewState.infoPanelGeometry,
    (g) => {
      this.viewState.infoPanelGeometry = g;
    },
  );

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
      <aside class="panel" {{this.applyGeometry}} {{this.observePanelSize}}>
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
                {{#each this.cycles key="key" as |cycle i|}}
                  <li class="panel__cycle">
                    <div class="panel__cycle-head">#{{add i 1}} · {{cycle.nodes.length}} nodes</div>
                    <ol class="panel__neighbors panel__neighbors--ordered">
                      {{#each cycle.cycleList.head key="@index" as |entry|}}
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
                      {{#if cycle.cycleList.hiddenCount}}
                        <li>
                          <button
                            type="button"
                            class="panel__cycle-hidden"
                            title="Show all {{cycle.nodes.length}} nodes"
                            {{on "click" (fn this.toggleCycleNodeList cycle.key)}}
                          >… {{cycle.cycleList.hiddenCount}} hidden — click to expand</button>
                        </li>
                      {{/if}}
                      {{#each cycle.cycleList.tail key="@index" as |entry|}}
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
                      {{#if
                        (and
                          (isExpanded this.expandedNodeLists cycle.key) (gt cycle.nodes.length 5)
                        )
                      }}
                        <li>
                          <button
                            type="button"
                            class="panel__cycle-hidden"
                            title="Collapse the node list"
                            {{on "click" (fn this.toggleCycleNodeList cycle.key)}}
                          >show less</button>
                        </li>
                      {{/if}}
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
                                    class="panel__cycle-hidden"
                                    title="Show all {{cycle.occurrencesLength}} occurrences"
                                    {{on "click" (fn this.toggleCycleOccList cycle.key)}}
                                  >… {{cycle.occList.hiddenCount}} hidden — click to expand</button>
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
                                    class="panel__cycle-hidden"
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

          <p class="panel__cycles-status">
            {{#if this.hasAnyCycles}}
              There is at least one cycle.
            {{else}}
              There are no cycles.
            {{/if}}
          </p>
        </div>
      </aside>
    {{/if}}
  </template>
}

function add(a: number, b: number): number {
  return a + b;
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
