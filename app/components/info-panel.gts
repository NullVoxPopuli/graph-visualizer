import Component from "@glimmer/component";
import { fn } from "@ember/helper";
import { on } from "@ember/modifier";
import { action } from "@ember/object";
import { service } from "@ember/service";

import { buildContraction } from "#lib/contract";
import { findShortestCycleThrough } from "#lib/cycle";
import { computeRadii } from "#lib/pack";

import type GraphService from "#services/graph";
import type ViewStateService from "#services/view-state";
import type VisualizerService from "#services/visualizer";

interface NeighborEntry {
  id: string;
  label: string;
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
   * Nodes that form the shortest cycle passing through the currently
   * selected node, in cycle order. Empty if no cycle exists. Runs on the
   * same contracted graph the renderer uses, so what shows in this list
   * matches the red-outlined nodes on the canvas — even when files are
   * hidden and edges have been folded into package-level paths.
   */
  get cycleNodes(): NeighborEntry[] {
    const info = this.info;
    const g = this.graph.current;

    if (!info || !g) return [];

    // Radii from `computeRadii` mirror what the visualizer service builds.
    // We don't read the resolved scene here — the cycle is purely a
    // topology question and shouldn't wait on the force layout.
    const radii = computeRadii(g.inDegree, g.outDegree);
    const contraction = buildContraction(
      g,
      radii,
      this.viewState.hiddenNodeTypes,
      this.viewState.collapsedIds,
    );
    const remap = contraction?.nodeRemap ?? null;
    const cycle = findShortestCycleThrough(g, info.index, remap);

    if (!cycle) return [];

    return cycle.map((idx) => ({ id: g.ids[idx]!, label: g.labels[idx]! }));
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

  @action
  close(): void {
    this.viewState.selectedId = null;
  }

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

  <template>
    {{#if this.info}}
      <aside class="panel">
        <div class="panel__head">
          <h2 class="panel__title">{{this.info.label}}</h2>
          <button type="button" class="panel__close" {{on "click" this.close}} aria-label="Close">×</button>
        </div>
        <p class="panel__id">id: <code>{{this.info.id}}</code></p>
        {{#if this.info.type}}
          <dl class="panel__stats">
            <dt>type</dt><dd>{{this.info.type}}</dd>
          </dl>
        {{/if}}

        <h3 class="panel__subhead">in ({{this.inNeighbors.length}})</h3>
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

        <h3 class="panel__subhead">out ({{this.outNeighbors.length}})</h3>
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

        <h3 class="panel__subhead">cycle ({{this.cycleNodes.length}})</h3>
        {{#if this.cycleNodes.length}}
          <ol class="panel__neighbors panel__neighbors--ordered">
            {{#each this.cycleNodes as |entry|}}
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
          </ol>
        {{else}}
          <p class="panel__empty">Not part of a cycle.</p>
        {{/if}}

        {{#if this.metaEntries.length}}
          <h3 class="panel__subhead">meta</h3>
          <dl class="panel__meta">
            {{#each this.metaEntries as |entry|}}
              <dt>{{entry.key}}</dt><dd>{{entry.value}}</dd>
            {{/each}}
          </dl>
        {{/if}}
      </aside>
    {{/if}}
  </template>
}
