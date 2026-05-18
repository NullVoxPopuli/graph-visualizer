import Component from "@glimmer/component";
import { service } from "@ember/service";

import { getPromiseState } from "reactiveweb/get-promise-state";

import type GraphService from "#services/graph";
import type VisualizerService from "#services/visualizer";

/** Stable empty arg so the unfiltered cycle query keeps one cache key
 *  in the visualizer service (resolves once, no flicker). */
const NO_FILTER = new Int32Array(0);

export default class Hud extends Component {
  @service declare visualizer: VisualizerService;
  @service declare graph: GraphService;

  /**
   * Whether the loaded graph has any directed cycle. Backed by the
   * resident Rust session's unfiltered cycle check (one stable,
   * service-memoized query resolved once after load — no per-render
   * worker traffic). `false` until that first result lands; the scene
   * overlay covers that window. Reflects whether the graph has cycles
   * at all, independent of the edge-type filter.
   */
  get hasAnyCycles(): boolean {
    if (!this.graph.current) return false;

    const p = this.visualizer.hasAnyCycle(NO_FILTER);

    if (!p) return false;

    return getPromiseState(p).resolved === true;
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
