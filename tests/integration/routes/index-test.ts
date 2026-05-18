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

    assert.deepEqual(calls, [["view"]], "returning visitor goes straight to the visualizer");
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
