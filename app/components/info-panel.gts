import Component from "@glimmer/component";
import { on } from "@ember/modifier";
import { action } from "@ember/object";
import { service } from "@ember/service";

import type GraphService from "#services/graph";
import type ViewStateService from "#services/view-state";

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
