import Component from "@glimmer/component";
import { service } from "@ember/service";

import { hasAnyCycle } from "#lib/cycle";

import type GraphService from "#services/graph";
import type ViewStateService from "#services/view-state";
import type VisualizerService from "#services/visualizer";

export default class Hud extends Component {
  @service declare visualizer: VisualizerService;
  @service declare graph: GraphService;
  @service declare viewState: ViewStateService;

  /**
   * Whether the loaded graph has any directed cycle. Same cheap
   * back-edge DFS the controls panel used before this moved here —
   * returns at the first back edge rather than enumerating cycles.
   */
  get hasAnyCycles(): boolean {
    const g = this.graph.current;

    if (!g) return false;

    return hasAnyCycle(g, this.viewState.hiddenEdgeTypes);
  }

  <template>
    <div class="hud">
      {{#if this.graph.current}}
        <span class="hud__cycles">
          {{#if this.hasAnyCycles}}
            There is at least one cycle.
          {{else}}
            There are no cycles.
          {{/if}}
        </span>
      {{/if}}
      <span class="hud__stats">
        {{this.visualizer.nodeCount}}
        nodes ·
        {{this.visualizer.edgeCount}}
        edges
        {{#if this.visualizer.isReady}}
          ·
          {{this.visualizer.communityCount}}
          communities · settled
        {{/if}}
      </span>
    </div>
  </template>
}
