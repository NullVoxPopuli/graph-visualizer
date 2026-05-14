import Route from "@ember/routing/route";

/**
 * Declares the visualizer's query params at the application level so
 * `RouterService#transitionTo({ queryParams })` actually serializes them
 * into the URL. Without this declaration the router holds the params in
 * `currentRoute.queryParams` but never writes them to `location.search`.
 *
 * All four are URL-only ({@link ViewStateService}) — flipping them must
 * not refresh the model.
 */
export default class ApplicationRoute extends Route {
  queryParams = {
    e: { refreshModel: false },
    h: { refreshModel: false },
    hidden: { refreshModel: false },
    sel: { refreshModel: false },
    r: { refreshModel: false },
    nd: { refreshModel: false },
    cd: { refreshModel: false },
  };
}
