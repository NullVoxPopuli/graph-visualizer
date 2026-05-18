import Route from "@ember/routing/route";
import { service } from "@ember/service";

import type RouterService from "@ember/routing/router-service";
import type GraphService from "#services/graph";

/**
 * The graph service kicks off an IndexedDB restore at boot. A returning
 * visitor landing on `/` should go straight to the visualizer rather
 * than see (or flash) the file picker, so wait for that restore to
 * settle here and redirect when it produced a graph.
 *
 * Awaiting in `beforeModel` puts the route into its loading substate —
 * `templates/index-loading` renders the "restoring" placeholder until
 * this resolves, so there's no file-picker flash either way.
 */
export default class IndexRoute extends Route {
  @service declare graph: GraphService;
  @service declare router: RouterService;

  async beforeModel(): Promise<void> {
    await this.graph.restored;

    if (this.graph.current) {
      this.router.replaceWith("view");
    }
  }
}
