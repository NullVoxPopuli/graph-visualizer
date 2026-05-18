import { module, test } from "qunit";
import { setupTest } from "ember-qunit";

import { loadGraph } from "#test-helpers/render";

import type GraphService from "#services/graph";

interface StubRouter {
  replaceWith: (...args: unknown[]) => unknown;
}

interface IndexRoute {
  beforeModel: () => Promise<void>;
}

module("Integration | route:index", function (hooks) {
  setupTest(hooks);

  test("redirects to the visualizer once the restore yields a graph", async function (assert) {
    const route = this.owner.lookup("route:index") as IndexRoute;
    const graph = this.owner.lookup("service:graph") as GraphService;
    const router = this.owner.lookup("service:router") as unknown as StubRouter;

    const calls: unknown[][] = [];

    router.replaceWith = (...args: unknown[]): Promise<unknown> => {
      calls.push(args);

      return Promise.resolve();
    };

    // Boot restore (empty test DB) settles, then a graph becomes present
    // — exactly the "returning visitor with a cached graph" case.
    await graph.restored;
    loadGraph(this.owner, { nodes: [{ id: "a", edges: ["b"] }, { id: "b" }] });

    await route.beforeModel();

    assert.deepEqual(calls, [["view"]], "redirected straight to the visualizer");
  });

  test("stays on the landing when the restore finds nothing", async function (assert) {
    const route = this.owner.lookup("route:index") as IndexRoute;
    const graph = this.owner.lookup("service:graph") as GraphService;
    const router = this.owner.lookup("service:router") as unknown as StubRouter;

    const calls: unknown[][] = [];

    router.replaceWith = (...args: unknown[]): Promise<unknown> => {
      calls.push(args);

      return Promise.resolve();
    };

    await graph.clear();
    await graph.restored;

    await route.beforeModel();

    assert.deepEqual(calls, [], "no redirect — the file picker renders");
  });
});
