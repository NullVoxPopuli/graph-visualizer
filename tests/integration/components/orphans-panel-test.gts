import { render, waitFor, waitUntil } from "@ember/test-helpers";
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
    // Orphan analysis now runs in the resident WASM session, so the
    // list resolves asynchronously — wait for it. Single orphan
    // (`alone`); the a-b cycle is *not* orphan.
    await waitUntil(
      () => document.querySelector(".cycles-panel__count")?.textContent?.trim() === "1",
      { timeout: 10_000 },
    );
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
