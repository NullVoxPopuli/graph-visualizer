import { render, waitFor } from "@ember/test-helpers";
import { module, test } from "qunit";
import { setupRenderingTest } from "ember-qunit";

import OrphansPanel from "#components/orphans-panel";
import { loadGraph, stubRouterTransitions, viewState } from "#test-helpers/render";

module("Integration | orphans-panel", function (hooks) {
  setupRenderingTest(hooks);

  hooks.beforeEach(function () {
    stubRouterTransitions(this.owner);
  });

  test("does not render when the panel is closed", async function (assert) {
    await render(<template><OrphansPanel /></template>);

    assert.dom(".orphans-panel").doesNotExist();
  });

  test("lists in-degree-zero nodes when open", async function (assert) {
    loadGraph(this.owner, {
      nodes: [{ id: "alone" }, { id: "a", edges: ["b"] }, { id: "b", edges: ["a"] }],
    });
    viewState(this.owner).orphansPanelOpen = true;

    await render(<template><OrphansPanel /></template>);

    assert.dom(".orphans-panel").exists();
    assert.dom(".cycles-panel__title").includesText("Orphans");
    // Orphan analysis runs in the resident WASM session; its test
    // waiter (see `SessionPipeline`) makes `render()` block until it
    // resolves, so the count is already settled. Single orphan
    // (`alone`); the a-b cycle is *not* an orphan.
    assert.dom(".cycles-panel__count").hasText("1");
    // `VerticalCollection` still mounts its rows on a later measurement
    // pass — third-party render deferral, not app async.
    await waitFor(".cycles-panel__node-label");
    assert.dom(".cycles-panel__node-label").hasText("alone");
  });

  test("shows the empty state when every node has incoming edges", async function (assert) {
    loadGraph(this.owner, {
      nodes: [
        { id: "a", edges: ["b"] },
        { id: "b", edges: ["a"] },
      ],
    });
    viewState(this.owner).orphansPanelOpen = true;

    await render(<template><OrphansPanel /></template>);

    assert.dom(".cycles-panel__empty").exists();
    assert.dom(".cycles-panel__empty").includesText("No orphan nodes");
  });
});
