import Component from "@glimmer/component";
import { on } from "@ember/modifier";
import { action } from "@ember/object";
import { service } from "@ember/service";

import { buildContraction } from "#lib/contract";
import { findShortestCycleThrough } from "#lib/cycle";
import { computeRadii } from "#lib/pack";

import type GraphService from "#services/graph";
import type ViewStateService from "#services/view-state";

interface CycleNode {
  id: string;
  label: string;
}

interface SelectedInfo {
  index: number;
  id: string;
  label: string;
  type: string;
  outDegree: number;
  inDegree: number;
  meta: unknown;
}

export default class InfoPanel extends Component {
  @service declare viewState: ViewStateService;
  @service declare graph: GraphService;

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
      outDegree: g.outDegree[idx] ?? 0,
      inDegree: g.inDegree[idx] ?? 0,
      meta: g.metas[idx],
    };
  }

  /**
   * Nodes that form the shortest cycle passing through the currently
   * selected node, in cycle order. Empty if no cycle exists. Runs on the
   * same contracted graph the renderer uses, so what shows in this list
   * matches the red-outlined nodes on the canvas — even when files are
   * hidden and edges have been folded into package-level paths.
   */
  get cycleNodes(): CycleNode[] {
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

  <template>
    {{#if this.info}}
      <aside class="panel">
        <div class="panel__head">
          <h2 class="panel__title">{{this.info.label}}</h2>
          <button type="button" class="panel__close" {{on "click" this.close}} aria-label="Close">×</button>
        </div>
        <p class="panel__id">id: <code>{{this.info.id}}</code></p>
        <dl class="panel__stats">
          {{#if this.info.type}}
            <dt>type</dt><dd>{{this.info.type}}</dd>
          {{/if}}
          <dt>out-degree</dt><dd>{{this.info.outDegree}}</dd>
          <dt>in-degree</dt><dd>{{this.info.inDegree}}</dd>
        </dl>
        {{#if this.cycleNodes.length}}
          <h3 class="panel__subhead">cycle ({{this.cycleNodes.length}} nodes)</h3>
          <ol class="panel__cycle">
            {{#each this.cycleNodes as |entry|}}
              <li>
                <span class="panel__cycle-label">{{entry.label}}</span>
                <code class="panel__cycle-id">{{entry.id}}</code>
              </li>
            {{/each}}
          </ol>
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
