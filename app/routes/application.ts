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
    arrows: { refreshModel: false },
    hulls: { refreshModel: false },
    cyclesOnly: { refreshModel: false },
    hiddenEdgeTypes: { refreshModel: false },
    hiddenNodeTypes: { refreshModel: false },
    hiddenNodes: { refreshModel: false },
    rootNodes: { refreshModel: false },
    includeGlobs: { refreshModel: false },
    excludeGlobs: { refreshModel: false },
    collapsed: { refreshModel: false },
    selected: { refreshModel: false },
    repulsion: { refreshModel: false },
    nodeDistance: { refreshModel: false },
    clusterDistance: { refreshModel: false },
    clustering: { refreshModel: false },
    cluster: { refreshModel: false },
    segments: { refreshModel: false },
    cyclesPanel: { refreshModel: false },
    cyclesPanelOpen: { refreshModel: false },
    orphansPanel: { refreshModel: false },
    orphansPanelOpen: { refreshModel: false },
    infoPanel: { refreshModel: false },
    // Per-section open/close overrides for the info panel's in / out /
    // cycles `<details>` elements. Without these declared here, Ember
    // silently drops them from `transitionTo({ queryParams })` and a
    // user's explicit close never makes it into `location.search` —
    // making the section pop back open the next time the auto-default
    // re-evaluates to "open" for a different selection.
    infoIn: { refreshModel: false },
    infoOut: { refreshModel: false },
    infoCycles: { refreshModel: false },
    controls: { refreshModel: false },
  };
}
