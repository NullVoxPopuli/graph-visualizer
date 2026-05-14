import Component from "@glimmer/component";
import { fn } from "@ember/helper";
import { on } from "@ember/modifier";
import { action } from "@ember/object";
import { service } from "@ember/service";

import type GraphService from "#services/graph";
import type ViewStateService from "#services/view-state";

interface EdgeTypeRow {
  id: number;
  name: string;
  count: number;
  hidden: boolean;
}

interface Signature {
  Args: {
    onResetView: () => void;
  };
}

export default class Controls extends Component<Signature> {
  @service declare viewState: ViewStateService;
  @service declare graph: GraphService;

  /**
   * Edge-type breakdown for the filter section. Returns an empty list when
   * the loaded graph has fewer than two distinct edge types (no point
   * surfacing the filter at all).
   */
  get edgeTypes(): EdgeTypeRow[] {
    const g = this.graph.current;

    if (!g) return [];

    const names = g.edgeTypeNames;
    const ids = g.edgeTypeIds;

    if (names.length < 2) return [];

    const counts = new Int32Array(names.length);

    for (let i = 0; i < ids.length; i++) counts[ids[i]!]!++;

    const hidden = this.viewState.hiddenEdgeTypes;
    const out: EdgeTypeRow[] = [];

    for (let id = 0; id < names.length; id++) {
      if (counts[id] === 0) continue;
      out.push({
        id,
        name: names[id] === "" ? "untyped" : names[id]!,
        count: counts[id]!,
        hidden: hidden.has(id),
      });
    }

    return out;
  }

  @action
  toggleEdges(): void {
    this.viewState.showEdges = !this.viewState.showEdges;
  }

  @action
  toggleHulls(): void {
    this.viewState.showHulls = !this.viewState.showHulls;
  }

  @action
  toggleEdgeType(id: number): void {
    this.viewState.toggleHiddenEdgeType(id);
  }

  <template>
    <div class="controls">
      <strong class="controls__title">Graph Visualizer</strong>
      <div class="controls__row">
        <label>
          <input type="checkbox" checked={{this.viewState.showEdges}} {{on "change" this.toggleEdges}} />
          edges
        </label>
        <label>
          <input type="checkbox" checked={{this.viewState.showHulls}} {{on "change" this.toggleHulls}} />
          cluster hulls
        </label>
      </div>
      {{#if this.edgeTypes.length}}
        <div class="controls__section">
          <div class="controls__section-label">edge types</div>
          <div class="controls__types">
            {{#each this.edgeTypes as |t|}}
              <label class="controls__type">
                <input
                  type="checkbox"
                  checked={{not t.hidden}}
                  {{on "change" (fn this.toggleEdgeType t.id)}}
                />
                <span class="controls__type-name">{{t.name}}</span>
                <span class="controls__type-count">{{t.count}}</span>
              </label>
            {{/each}}
          </div>
        </div>
      {{/if}}
      <div class="controls__row">
        <button type="button" {{on "click" @onResetView}}>Reset view</button>
      </div>
      <p class="controls__hint">
        drag: pan · wheel: zoom · click: select · right-click: clear
      </p>
    </div>
  </template>
}

function not(v: unknown): boolean {
  return !v;
}
