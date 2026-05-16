import { click, render, waitFor } from "@ember/test-helpers";
import { module, test } from "qunit";
import { setupRenderingTest } from "ember-qunit";

import CyclesPanel from "#components/cycles-panel";
import { loadGraph, stubRouterTransitions, viewState } from "#test-helpers/render";

module("Integration | cycles-panel", function (hooks) {
  setupRenderingTest(hooks);

  hooks.beforeEach(function () {
    stubRouterTransitions(this.owner);
  });

  test("does not render when the panel is closed", async function (assert) {
    loadGraph(this.owner, {
      nodes: [
        { id: "a", edges: ["b"] },
        { id: "b", edges: ["a"] },
      ],
    });

    await render(<template><CyclesPanel /></template>);

    assert.dom(".cycles-panel").doesNotExist();
  });

  test("renders the cycle list when open and the graph has cycles", async function (assert) {
    loadGraph(this.owner, {
      nodes: [
        { id: "a", edges: ["b"] },
        { id: "b", edges: ["a"] },
      ],
    });
    viewState(this.owner).cyclesPanelOpen = true;

    await render(<template><CyclesPanel /></template>);

    assert.dom(".cycles-panel").exists();
    assert.dom(".cycles-panel__title").includesText("Cycles");
    assert.dom(".cycles-panel__count").hasText("1", "one cycle in the graph");
    await waitFor(".cycle-id");
    assert.dom(".cycle-id").exists({ count: 1 }, "each entry has its short-id chip");
  });

  test("shows the empty state when the graph has no cycles", async function (assert) {
    loadGraph(this.owner, {
      nodes: [{ id: "a", edges: ["b"] }, { id: "b" }],
    });
    viewState(this.owner).cyclesPanelOpen = true;

    await render(<template><CyclesPanel /></template>);

    assert.dom(".cycles-panel__empty").includesText("This graph has no cycles");
  });

  test("clicking a cycle header toggles its body open/closed", async function (assert) {
    loadGraph(this.owner, {
      nodes: [
        { id: "a", edges: ["b"] },
        { id: "b", edges: ["c"] },
        { id: "c", edges: ["a"] },
      ],
    });
    viewState(this.owner).cyclesPanelOpen = true;

    await render(<template><CyclesPanel /></template>);
    // `VerticalCollection` renders its visible items after the initial
    // `await render()` resolves — `render()` waits on the Ember run
    // loop, but VC's first paint defers behind a measurement pass that
    // runs in its own microtask. Wait for at least one entry to land
    // in the DOM before driving the test.
    await waitFor(".cycles-panel__entry");

    assert.dom(".cycles-panel__entry").exists({ count: 1 });
    assert.dom(".cycles-panel__nodes").exists("body open by default");
    assert.dom(".cycles-panel__header").hasAttribute("aria-expanded", "true");

    await click(".cycles-panel__header");

    assert.dom(".cycles-panel__nodes").doesNotExist("body hidden after one click");
    assert.dom(".cycles-panel__header").hasAttribute("aria-expanded", "false");

    await click(".cycles-panel__header");

    assert.dom(".cycles-panel__nodes").exists("body restored on second click");
    assert.dom(".cycles-panel__header").hasAttribute("aria-expanded", "true");
  });
});
