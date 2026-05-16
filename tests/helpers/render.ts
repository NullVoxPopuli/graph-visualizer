import { makeGraph } from "./graph.ts";

import type { InputGraph } from "#lib/schema";
import type { LoadedGraph } from "#lib/types";
import type GraphService from "#services/graph";
import type ViewStateService from "#services/view-state";

interface Owner {
  lookup(name: string): unknown;
}

/**
 * Plant a fixture graph into the `graph` service so a rendering test
 * can drive components that read from it. Returns the parsed graph so
 * the test can grab node ids without re-traversing the input.
 */
export function loadGraph(owner: Owner, input: InputGraph): LoadedGraph {
  const graph = makeGraph(input);
  const svc = owner.lookup("service:graph") as GraphService;

  svc.current = graph;

  return graph;
}

/** Convenience: typed lookup of the view-state service. */
export function viewState(owner: Owner): ViewStateService {
  return owner.lookup("service:view-state") as ViewStateService;
}

/**
 * `setupRenderingTest` boots the app container but never `visit`s a
 * route, so the router's microlib is undefined and any
 * `router.transitionTo({ queryParams })` call throws
 * `Cannot read properties of undefined (reading 'activeTransition')`.
 *
 * ViewState's setters write to the in-memory `#qps` store synchronously
 * AND schedule an rAF that calls `router.transitionTo` to mirror the
 * value into the URL. The URL write is not what we're testing, so
 * neutralizing it is fine — the in-memory store still drives reads,
 * which is what components consume.
 *
 * Call this once per rendering test (or in `hooks.beforeEach`) before
 * touching `viewState.…` setters.
 */
export function stubRouterTransitions(owner: Owner): void {
  const router = owner.lookup("service:router") as {
    transitionTo: (...args: unknown[]) => Promise<unknown>;
  };

  router.transitionTo = (): Promise<unknown> => Promise.resolve();
}
