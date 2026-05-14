import Route from "@ember/routing/route";

/**
 * Declares the visualizer's query params at the application level so
 * `RouterService#transitionTo({ queryParams })` actually serializes them
 * into the URL. Without this declaration the router holds the params in
 * `currentRoute.queryParams` but never writes them to `location.search`.
 *
 * All of them are URL-only ({@link ViewStateService}) — flipping them must
 * not refresh the model.
 */
export default class ApplicationRoute extends Route {
  queryParams = {
    edges: { refreshModel: false },
    hulls: { refreshModel: false },
    hiddenEdgeTypes: { refreshModel: false },
    hiddenNodeTypes: { refreshModel: false },
    collapsed: { refreshModel: false },
    selected: { refreshModel: false },
    repulsion: { refreshModel: false },
    nodeDistance: { refreshModel: false },
    clusterDistance: { refreshModel: false },
    clustering: { refreshModel: false },
  };
}
