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

  function stubReplaceWith(owner: { lookup(name: string): unknown }): unknown[][] {
    const router = owner.lookup("service:router") as StubRouter;
    const calls: unknown[][] = [];

    router.replaceWith = (...args: unknown[]): Promise<unknown> => {
      calls.push(args);

      return Promise.resolve();
    };

    return calls;
  }

  test("redirects to the visualizer once the restore yields a graph", async function (assert) {
    const route = this.owner.lookup("route:index") as IndexRoute;
    const graph = this.owner.lookup("service:graph") as GraphService;
    const calls = stubReplaceWith(this.owner);

    await graph.restored;
    loadGraph(this.owner, { nodes: [{ id: "a", edges: ["b"] }, { id: "b" }] });

    await route.beforeModel();

    assert.deepEqual(
      calls,
      [["view", { queryParams: {} }]],
      "returning visitor goes straight to the visualizer; small graph keeps default QPs",
    );
  });

  test("disables edges by default when the restored graph is large", async function (assert) {
    const route = this.owner.lookup("route:index") as IndexRoute;
    const graph = this.owner.lookup("service:graph") as GraphService;
    const calls = stubReplaceWith(this.owner);

    await graph.restored;
    // 1001 nodes — one past the threshold — to drive the off-by-default branch.
    const nodes = Array.from({ length: 1001 }, (_, i) => ({ id: `n${i}` }));

    loadGraph(this.owner, { nodes });

    await route.beforeModel();

    assert.deepEqual(
      calls,
      [["view", { queryParams: { edges: "0" } }]],
      "above the threshold the visualizer loads with edges turned off",
    );
  });

  test("redirects to the analyze screen when nothing was restored", async function (assert) {
    const route = this.owner.lookup("route:index") as IndexRoute;
    const graph = this.owner.lookup("service:graph") as GraphService;
    const calls = stubReplaceWith(this.owner);

    await graph.clear();
    await graph.restored;

    await route.beforeModel();

    assert.deepEqual(calls, [["analyze"]], "first-time visitor lands on the analyze screen");
  });
});
