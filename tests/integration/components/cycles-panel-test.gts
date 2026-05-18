import { click, render, waitFor, waitUntil } from "@ember/test-helpers";
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
    // Cycle enumeration now resolves from the resident Rust session.
    await waitUntil(
      () => document.querySelector(".cycles-panel__count")?.textContent?.trim() === "1",
    );
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

  test("renders the raw file under each step when a node type is hidden", async function (assert) {
    const g = loadGraph(this.owner, {
      nodes: [
        { id: "pkgA", type: "package", edges: ["fileA"] },
        { id: "fileA", type: "file", edges: ["pkgB"] },
        { id: "pkgB", type: "package", edges: ["fileB"] },
        { id: "fileB", type: "file", edges: ["pkgA"] },
      ],
    });
    const fileType = g.nodeTypeNames.indexOf("file");

    viewState(this.owner).toggleHiddenNodeType(fileType);
    viewState(this.owner).cyclesPanelOpen = true;

    await render(<template><CyclesPanel /></template>);
    await waitFor(".cycles-panel__entry");

    assert
      .dom(".cycles-panel__node-raw")
      .exists("raw-file line renders under bundled steps when files fold into packages");
  });

  test("glob exclude filter hides nodes from the cycles list", async function (assert) {
    loadGraph(this.owner, {
      // Two independent 2-cycles. Excluding `b/*` drops `b/1` so only
      // the `a → x → a` cycle survives in the list.
      nodes: [
        { id: "a", edges: ["x"] },
        { id: "x", edges: ["a"] },
        { id: "b/1", edges: ["c"] },
        { id: "c", edges: ["b/1"] },
      ],
    });
    viewState(this.owner).cyclesPanelOpen = true;

    await render(<template><CyclesPanel /></template>);
    await waitFor(".cycles-panel__entry");

    assert.dom(".cycles-panel__count").hasText("2", "both cycles present before filter");

    viewState(this.owner).addExcludeGlob("b/*");
    await waitFor(".cycles-panel__count");

    assert
      .dom(".cycles-panel__count")
      .hasText("1", "the b/1-c cycle drops out once b/1 is glob-excluded");
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
