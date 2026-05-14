import Component from "@glimmer/component";
import { action } from "@ember/object";
import { LinkTo } from "@ember/routing";
import { service } from "@ember/service";

import ExampleLinks from "#components/example-links";
import FileDrop from "#components/file-drop";

import type RouterService from "@ember/routing/router-service";
import type { LoadedGraph } from "#lib/types";
import type GraphService from "#services/graph";

export default class IndexPage extends Component {
  @service declare graph: GraphService;
  @service declare router: RouterService;

  @action
  onParsed(g: LoadedGraph): void {
    this.graph.load(g);
    void this.router.transitionTo("view");
  }

  <template>
    <section class="landing">
      <div class="landing__hero">
        <h1 class="landing__title">Visualize your graph</h1>
        <p class="landing__lede">
          Drop a JSON file describing your nodes and edges and explore an
          interactive force-directed layout.
        </p>
        <p class="landing__privacy">
          <strong>Your data stays on this device.</strong> The file you drop is
          read locally in your browser. Nothing is uploaded, sent to a server,
          or persisted &mdash; close the tab and it&apos;s gone.
        </p>
      </div>
      <FileDrop @onParsed={{this.onParsed}} class="landing__drop" />
      <ExampleLinks @onParsed={{this.onParsed}} @prefix="or try an example:" />
      <p class="landing__docs">
        New here?
        <LinkTo @route="docs">See the JSON format the visualizer expects.</LinkTo>
      </p>
    </section>
  </template>
}
