import Service, { service } from "@ember/service";

import { viewQueryParamDefaults } from "#lib/view-defaults";

import type RouterService from "@ember/routing/router-service";
import type { ParsedInput } from "#components/file-drop";
import type GraphService from "#services/graph";
import type ViewStateService from "#services/view-state";

/**
 * The one place that turns a parsed file into "we are now viewing this
 * graph": reset graph-scoped URL state, load + persist it, then hand
 * off to the visualizer. Both the `/analyze` screen and the global
 * document drop zone funnel through here so a drop anywhere is exactly
 * equivalent to picking a file on the analyze screen.
 */
export default class GraphLoaderService extends Service {
  @service declare graph: GraphService;
  @service declare viewState: ViewStateService;
  @service declare router: RouterService;

  async open(input: ParsedInput): Promise<void> {
    // Wipe URL state that points into the old graph (selected node,
    // hidden ids, type-id filters) — otherwise the next graph inherits
    // stale toggles and the cycle list / canvas can look like they
    // "didn't update".
    this.viewState.resetGraphSpecific();
    await this.graph.load(input.parsed, { text: input.text, name: input.name });
    this.router.transitionTo("view", { queryParams: viewQueryParamDefaults(input.parsed) });
  }
}
