import Component from "@glimmer/component";
import { action } from "@ember/object";
import { LinkTo } from "@ember/routing";
import { service } from "@ember/service";

import { modifier } from "ember-modifier";

import ExampleLinks from "#components/example-links";
import FileDrop from "#components/file-drop";

import type RouterService from "@ember/routing/router-service";
import type { ParsedInput } from "#components/file-drop";
import type GraphService from "#services/graph";
import type ViewStateService from "#services/view-state";

export default class IndexPage extends Component {
  @service declare graph: GraphService;
  @service declare router: RouterService;
  @service declare viewState: ViewStateService;

  /**
   * The graph service kicks off an IndexedDB restore in its constructor
   * (`restoring` is true until that round-trip settles). Landing here
   * with a previously-cached graph must not flash the "choose a file"
   * UI: while the restore is in flight — or once it has produced a
   * graph — show the restoring placeholder instead. Only when the
   * restore settles with nothing cached do we fall through to the file
   * picker.
   */
  get showRestoring(): boolean {
    return this.graph.restoring || this.graph.current !== null;
  }

  /**
   * Once a graph exists (restored from IDB, or just loaded) leave the
   * index route for the visualizer. Reading `graph.current` here tracks
   * it, so the modifier re-runs and redirects the moment the async
   * restore resolves — no flicker through the landing page.
   */
  redirectWhenLoaded = modifier(() => {
    if (this.graph.current) void this.router.transitionTo("view");
  });

  @action
  async onParsed(input: ParsedInput): Promise<void> {
    // Wipe URL state that points into the old graph (selected node, hidden
    // ids, type-id filters) — otherwise the next graph inherits stale
    // toggles and the cycle list / canvas can look like they "didn't
    // update".
    this.viewState.resetGraphSpecific();
    await this.graph.load(input.parsed, { text: input.text, name: input.name });
    void this.router.transitionTo("view");
  }

  <template>
    {{#if this.showRestoring}}
      <section class="empty-state" {{this.redirectWhenLoaded}}>
        <p>Restoring previous graph&hellip;</p>
      </section>
    {{else}}
      <section class="landing">
        <div class="landing__hero">
          <h1 class="landing__title">Visualize your graph</h1>
          <p class="landing__lede">
            Drop a JSON file describing your nodes and edges and explore an interactive
            force-directed layout.
          </p>
          <p class="landing__privacy">
            <strong>Your data stays on this device.</strong>
            The file you drop is read locally in your browser and cached in
            <code>IndexedDB</code>
            so a refresh keeps you where you were. Nothing is uploaded or sent to a server.
          </p>
        </div>
        <FileDrop @onParsed={{this.onParsed}} class="landing__drop" />
        <ExampleLinks @onParsed={{this.onParsed}} @prefix="or try an example:" />
        <p class="landing__docs">
          New here?
          <LinkTo @route="docs">See the JSON format the visualizer expects.</LinkTo>
        </p>
      </section>
    {{/if}}
  </template>
}
