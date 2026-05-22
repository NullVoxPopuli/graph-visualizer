import { click, render, triggerEvent, waitFor } from "@ember/test-helpers";
import { module, test } from "qunit";
import { setupRenderingTest } from "ember-qunit";

import CyclesPanel from "#components/cycles-panel";
import { loadGraph, stubRouterTransitions, viewState } from "#test-helpers/render";

import type VisualizerService from "#services/visualizer";

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
    // Cycle enumeration runs in the resident Rust session; its test
    // waiter makes `render()` block until it resolves, so the count is
    // already settled.
    assert.dom(".cycles-panel__count").hasText("1", "one cycle in the graph");
    // `VerticalCollection` mounts rows on a later measurement pass —
    // third-party render deferral, not app async.
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

  test("file-only cycle that bridges two packages surfaces as a package cycle when files are hidden", async function (assert) {
    // Packages do not appear in any raw cycle directly — the only
    // elementary cycle is b → c → e → b among files. The expected
    // behavior is: hiding the file type folds b/c onto package a and
    // e onto package d, and the cycle still surfaces as a package-level
    // pair {a, d}. This has regressed before; keep the assertion at
    // the integration layer so the whole Rust + JS pipeline is on the
    // hook for it.
    const g = loadGraph(this.owner, {
      nodes: [
        { id: "a", type: "package", edges: ["b", "c"] },
        { id: "d", type: "package", edges: ["e", "f"] },
        { id: "b", type: "file", edges: ["c"] },
        { id: "c", type: "file", edges: ["e"] },
        { id: "e", type: "file", edges: ["b"] },
        { id: "f", type: "file" },
      ],
    });
    const fileType = g.nodeTypeNames.indexOf("file");

    viewState(this.owner).toggleHiddenNodeType(fileType);
    viewState(this.owner).cyclesPanelOpen = true;

    await render(<template><CyclesPanel /></template>);
    await waitFor(".cycles-panel__entry");

    assert
      .dom(".cycles-panel__count")
      .hasText("1", "the file cycle contracts to one package cycle");

    const labels = Array.from(document.querySelectorAll(".cycles-panel__node-label"))
      .map((el) => el.textContent?.trim() ?? "")
      .toSorted();

    assert.deepEqual(labels, ["a", "d"], "bundled cycle's nodes are exactly the two packages");
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

  test("collapsing a cycle, then clicking a cycle node to view it, does not reshuffle the list or reopen others", async function (assert) {
    // Two independent cycles: a 2-node (a↔b) and a 3-node (c→d→e→c).
    loadGraph(this.owner, {
      nodes: [
        { id: "a", edges: ["b"] },
        { id: "b", edges: ["a"] },
        { id: "c", edges: ["d"] },
        { id: "d", edges: ["e"] },
        { id: "e", edges: ["c"] },
      ],
    });
    viewState(this.owner).cyclesPanelOpen = true;

    await render(<template><CyclesPanel /></template>);
    await waitFor(".cycles-panel__entry");

    assert.dom(".cycles-panel__entry").exists({ count: 2 }, "both cycles listed");

    // Entries are shortest-first: [0] = 2-node (a,b), [1] = 3-node.
    const headerOf = (i: number): Element => {
      const entry = document.querySelectorAll(".cycles-panel__entry")[i];
      const header = entry?.querySelector(".cycles-panel__header");

      if (!header) throw new Error(`no header for cycle entry ${i}`);

      return header;
    };

    // Collapse the first cycle's body. The second stays expanded.
    await click(headerOf(0));
    assert.dom(headerOf(0)).hasAttribute("aria-expanded", "false", "cycle 1 collapsed");
    assert.dom(headerOf(1)).hasAttribute("aria-expanded", "true", "cycle 2 still expanded");

    // Click a node inside the still-open second cycle to view it
    // (selection → "c").
    await click('.cycles-panel__entry .cycles-panel__node[title="c"]');

    // Navigating must not reshuffle the panel: both cycles still listed,
    // cycle 1 still collapsed, cycle 2 still expanded.
    assert.dom(".cycles-panel__entry").exists({ count: 2 }, "list not re-scoped away by the click");
    assert
      .dom(headerOf(0))
      .hasAttribute("aria-expanded", "false", "collapsed cycle stays collapsed");
    assert.dom(headerOf(1)).hasAttribute("aria-expanded", "true", "other cycle stays as it was");
  });

  test("double-clicking a cycle node selects the node and asks the canvas to zoom in", async function (assert) {
    loadGraph(this.owner, {
      nodes: [
        { id: "a", edges: ["b"] },
        { id: "b", edges: ["c"] },
        { id: "c", edges: ["a"] },
      ],
    });
    viewState(this.owner).cyclesPanelOpen = true;

    const vis = this.owner.lookup("service:visualizer") as VisualizerService;

    await render(<template><CyclesPanel /></template>);
    await waitFor(".cycles-panel__entry");

    // The single-click handler (selectNode) already queues a plain
    // focus on the panel-driven selection — clear it so the assertion
    // is strictly about the dblclick's zoom-in variant.
    vis.pendingFocus = null;

    await triggerEvent('.cycles-panel__entry .cycles-panel__node[title="b"]', "dblclick");

    assert.strictEqual(viewState(this.owner).selectedId, "b", "selection followed the dblclick");
    assert.strictEqual(vis.pendingFocus?.id, "b", "canvas focus targets the same node");
    assert.true(vis.pendingFocus?.zoomIn, "request is the zoom-in variant, not a plain recenter");
  });
});
