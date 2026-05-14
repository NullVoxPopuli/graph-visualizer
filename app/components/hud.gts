import Component from "@glimmer/component";
import { service } from "@ember/service";

import type VisualizerService from "#services/visualizer";

export default class Hud extends Component {
  @service declare visualizer: VisualizerService;

  <template>
    <div class="hud">
      {{this.visualizer.nodeCount}}
      nodes ·
      {{this.visualizer.edgeCount}}
      edges
      {{#if this.visualizer.isReady}}
        ·
        {{this.visualizer.communityCount}}
        communities · settled
      {{/if}}
    </div>
  </template>
}
