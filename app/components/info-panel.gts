import Component from "@glimmer/component";
import { fn } from "@ember/helper";
import { on } from "@ember/modifier";
import { action } from "@ember/object";
import { service } from "@ember/service";

import { buildContraction } from "#lib/contract";
import {
  canonicalCycleKey,
  contractCycle as sharedContractCycle,
  findAllCycles,
  findBundledCyclesViaRaw,
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

interface CycleEntry {
  /** Bundled cycle — the visible reps the canvas red-rings. */
  nodes: NeighborEntry[];
  /**
   * Underlying raw nodes that participate in cycles contracting to this
   * bundled one, with counts. Empty when no contraction is active (the
   * bundled cycle is the raw cycle, no separate accounting is useful).
   */
  occurrences: OccurrenceEntry[];
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

    // Bundled cycles come from `findBundledCyclesViaRaw` — only cycles
    // backed by an actual raw elementary cycle qualify. This is the same
    // source the renderer uses to draw red rings, so the info-panel list
    // and the canvas can't disagree.
    const bundledCycles = findBundledCyclesViaRaw(g, remap).filter((c) => c.includes(info.index));

    // Pre-index raw cycles by their bundled canonical key so each
    // bundled cycle can grab its matching raw cycles in one lookup. We
    // need raw cycles for the occurrence counts.
    const rawsByBundle = new Map<string, number[][]>();
    const rawCycles = findAllCycles(g, null);

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
        occurrences,
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
   * Default to open when the section is short enough to scan at a glance;
   * collapse otherwise so a node with hundreds of incoming edges doesn't
   * push the rest of the panel off-screen. The user can click to toggle
   * either way; we only set the initial state.
   */
  static readonly AUTO_OPEN_THRESHOLD = 20;

  get inOpen(): boolean {
    return this.inNeighbors.length <= InfoPanel.AUTO_OPEN_THRESHOLD;
  }

  get outOpen(): boolean {
    return this.outNeighbors.length <= InfoPanel.AUTO_OPEN_THRESHOLD;
  }

  get cyclesOpen(): boolean {
    return this.cycles.length <= InfoPanel.AUTO_OPEN_THRESHOLD;
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
            <summary class="panel__subhead">in ({{this.inNeighbors.length}})</summary>
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
            <summary class="panel__subhead">out ({{this.outNeighbors.length}})</summary>
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
            <summary class="panel__subhead">cycles ({{this.cycles.length}})</summary>
            {{#if this.cycles.length}}
              <ol class="panel__cycles">
                {{#each this.cycles key="key" as |cycle i|}}
                  <li class="panel__cycle">
                    <div class="panel__cycle-head">#{{add i 1}} · {{cycle.nodes.length}} nodes</div>
                    <ol class="panel__neighbors panel__neighbors--ordered">
                      {{#each cycle.nodes key="id" as |entry|}}
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
                            {{#if (notEq entry.id entry.label)}}
                              <code class="panel__neighbor-id">{{entry.id}}</code>
                            {{/if}}
                          </button>
                        </li>
                      {{/each}}
                    </ol>
                    {{#if cycle.occurrences.length}}
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
                            {{#each cycle.occurrences key="id" as |entry|}}
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
