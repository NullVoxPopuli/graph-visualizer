import Component from "@glimmer/component";
import { fn } from "@ember/helper";
import { on } from "@ember/modifier";
import { action } from "@ember/object";
import { service } from "@ember/service";

import type GraphService from "#services/graph";
import type ViewStateService from "#services/view-state";

const REPULSION_MIN = 1;
const REPULSION_MAX = 30;
const REPULSION_STEP = 0.5;
const NODE_DIST_MIN = 5;
const NODE_DIST_MAX = 120;
const NODE_DIST_STEP = 2;
const CLUSTER_DIST_MIN = 30;
const CLUSTER_DIST_MAX = 800;
const CLUSTER_DIST_STEP = 10;

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

  @action
  setRepulsion(ev: Event): void {
    const v = Number.parseFloat((ev.target as HTMLInputElement).value);

    if (Number.isFinite(v)) this.viewState.repulsion = v;
  }

  @action
  setNodeDistance(ev: Event): void {
    const v = Number.parseFloat((ev.target as HTMLInputElement).value);

    if (Number.isFinite(v)) this.viewState.nodeDistance = v;
  }

  @action
  setClusterDistance(ev: Event): void {
    const v = Number.parseFloat((ev.target as HTMLInputElement).value);

    if (Number.isFinite(v)) this.viewState.clusterDistance = v;
  }

  <template>
    <div class="controls">
      <div class="controls__row">
        <label>
          <input
            type="checkbox"
            checked={{this.viewState.showEdges}}
            {{on "change" this.toggleEdges}}
          />
          edges
        </label>
        <label>
          <input
            type="checkbox"
            checked={{this.viewState.showHulls}}
            {{on "change" this.toggleHulls}}
          />
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
      <div class="controls__section">
        <div class="controls__section-label">layout</div>
        <label class="controls__slider">
          <span class="controls__slider-name">node distance</span>
          <input
            type="range"
            min={{NODE_DIST_MIN}}
            max={{NODE_DIST_MAX}}
            step={{NODE_DIST_STEP}}
            value={{this.viewState.nodeDistance}}
            {{on "change" this.setNodeDistance}}
          />
          <span class="controls__slider-value">{{this.viewState.nodeDistance}}</span>
        </label>
        <label class="controls__slider">
          <span class="controls__slider-name">cluster distance</span>
          <input
            type="range"
            min={{CLUSTER_DIST_MIN}}
            max={{CLUSTER_DIST_MAX}}
            step={{CLUSTER_DIST_STEP}}
            value={{this.viewState.clusterDistance}}
            {{on "change" this.setClusterDistance}}
          />
          <span class="controls__slider-value">{{this.viewState.clusterDistance}}</span>
        </label>
        <label class="controls__slider">
          <span class="controls__slider-name">repulsion</span>
          <input
            type="range"
            min={{REPULSION_MIN}}
            max={{REPULSION_MAX}}
            step={{REPULSION_STEP}}
            value={{this.viewState.repulsion}}
            {{on "change" this.setRepulsion}}
          />
          <span class="controls__slider-value">{{this.viewState.repulsion}}</span>
        </label>
      </div>
      <div class="controls__row">
        <button type="button" {{on "click" @onResetView}}>Reset view</button>
      </div>
      <p class="controls__hint">
        drag / wheel: pan · ctrl+wheel / pinch: zoom · click: select · right-click: clear
      </p>
    </div>
  </template>
}

function not(v: unknown): boolean {
  return !v;
}
