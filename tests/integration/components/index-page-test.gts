import { render, waitUntil } from "@ember/test-helpers";
import { module, test } from "qunit";
import { setupRenderingTest } from "ember-qunit";

import IndexPage from "#app/templates/index";
import { loadGraph, stubRouterTransitions } from "#test-helpers/render";

import type GraphService from "#services/graph";

interface StubRouter {
  transitionTo: (...args: unknown[]) => Promise<unknown>;
}

module("Integration | index-page", function (hooks) {
  setupRenderingTest(hooks);

  hooks.beforeEach(function () {
    stubRouterTransitions(this.owner);
  });

  test("shows the restoring placeholder, not the file picker, while a previous graph is restored", async function (assert) {
    const graph = this.owner.lookup("service:graph") as GraphService;

    // Let the constructor's (empty-DB) restore settle, then drive
    // `restoring` ourselves so nothing else flips it mid-assertion.
    await graph.clear();
    await waitUntil(() => graph.restoring === false);
    graph.restoring = true;

    await render(<template><IndexPage /></template>);

    assert.dom(".empty-state").includesText("Restoring previous graph");
    assert.dom(".landing").doesNotExist("file picker is not shown during restore");
    assert.dom(".landing__drop").doesNotExist();
  });

  test("shows the file picker once the restore settles with nothing cached", async function (assert) {
    const graph = this.owner.lookup("service:graph") as GraphService;

    await graph.clear();
    await waitUntil(() => graph.restoring === false);

    await render(<template><IndexPage /></template>);

    assert.dom(".landing").exists("file picker shown when there is nothing to restore");
    assert.dom(".landing__drop").exists();
    assert.dom(".empty-state").doesNotExist();
  });

  test("redirects to the visualizer once a graph is available", async function (assert) {
    const graph = this.owner.lookup("service:graph") as GraphService;
    const router = this.owner.lookup("service:router") as unknown as StubRouter;

    const transitions: unknown[][] = [];

    router.transitionTo = (...args: unknown[]): Promise<unknown> => {
      transitions.push(args);

      return Promise.resolve();
    };

    await graph.clear();
    await waitUntil(() => graph.restoring === false);
    // A restored/loaded graph is now present.
    loadGraph(this.owner, { nodes: [{ id: "a", edges: ["b"] }, { id: "b" }] });

    await render(<template><IndexPage /></template>);

    assert.deepEqual(
      transitions,
      [["view"]],
      "redirected straight to the visualizer instead of rendering the landing",
    );
    assert.dom(".landing").doesNotExist("never flashed the file picker");
  });
});
