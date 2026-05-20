import Route from "@ember/routing/route";
import { service } from "@ember/service";

import { viewQueryParamDefaults } from "#lib/view-defaults";

import type RouterService from "@ember/routing/router-service";
import type GraphService from "#services/graph";

/**
 * `/` is a pure redirector. The graph service kicks off an IndexedDB
 * restore at boot; once it settles we send the visitor to the
 * visualizer if a graph was restored, or to the `/analyze` screen if
 * not. The landing UI lives at its own `/analyze` URL (linked from the
 * header) so it's reachable on demand, not just on a cold start.
 *
 * Awaiting here puts the route in its loading substate —
 * `templates/index-loading` renders the "restoring" placeholder until
 * this resolves, so there's no file-picker flash either way.
 */
export default class IndexRoute extends Route {
  @service declare graph: GraphService;
  @service declare router: RouterService;

  async beforeModel(): Promise<void> {
    await this.graph.restored;

    const restored = this.graph.current;

    if (!restored) {
      this.router.replaceWith("analyze");

      return;
    }

    this.router.replaceWith("view", { queryParams: viewQueryParamDefaults(restored) });
  }
}
