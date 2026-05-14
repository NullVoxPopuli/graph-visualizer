import Component from "@glimmer/component";
import { LinkTo } from "@ember/routing";
import { service } from "@ember/service";

import Visualizer from "#components/visualizer";

import type GraphService from "#services/graph";

export default class ViewPage extends Component {
  @service declare graph: GraphService;

  <template>
    {{#if this.graph.current}}
      <Visualizer />
    {{else}}
      <section class="empty-state">
        <h1>No graph loaded</h1>
        <p>
          <LinkTo @route="index">Go back to the home page</LinkTo>
          and drop a JSON file to get started.
        </p>
      </section>
    {{/if}}
  </template>
}
