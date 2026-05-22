/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { click, findAll, render, triggerEvent } from "@ember/test-helpers";
import { module, test } from "qunit";
import { setupRenderingTest } from "ember-qunit";

import InfoPanel from "#components/info-panel";
import { loadGraph, stubRouterTransitions, viewState } from "#test-helpers/render";

import type VisualizerService from "#services/visualizer";

module("Integration | info-panel", function (hooks) {
  setupRenderingTest(hooks);

  hooks.beforeEach(function () {
    stubRouterTransitions(this.owner);
  });

  test("does not render when nothing is selected", async function (assert) {
    loadGraph(this.owner, {
      nodes: [{ id: "a" }],
    });

    await render(<template><InfoPanel /></template>);

    assert.dom(".info-panel").doesNotExist();
  });

  test("renders the selected node's label and id", async function (assert) {
    loadGraph(this.owner, {
      nodes: [
        { id: "alpha", label: "Alpha", edges: ["beta"] },
        { id: "beta", label: "Beta" },
      ],
    });
    viewState(this.owner).selectedId = "alpha";

    await render(<template><InfoPanel /></template>);

    assert.dom(".info-panel").exists();
    assert.dom(".panel__title").hasText("Alpha");
    assert.dom(".panel__id code").hasText("alpha");
  });

  test("lists in / out neighbors", async function (assert) {
    loadGraph(this.owner, {
      nodes: [
        { id: "src", label: "Src", edges: ["target"] },
        { id: "target", label: "Target", edges: ["sink"] },
        { id: "sink", label: "Sink" },
      ],
    });
    viewState(this.owner).selectedId = "target";

    await render(<template><InfoPanel /></template>);

    // `in` section lists Src; `out` lists Sink.
    assert.dom(".panel__neighbors").exists({ count: 2 }, "both in and out neighbor lists render");
    assert.dom(".info-panel").includesText("Src");
    assert.dom(".info-panel").includesText("Sink");
  });

  test("shows the cycles section when the selected node sits on a cycle", async function (assert) {
    loadGraph(this.owner, {
      nodes: [
        { id: "a", edges: ["b"] },
        { id: "b", edges: ["c"] },
        { id: "c", edges: ["a"] },
      ],
    });
    viewState(this.owner).selectedId = "a";

    await render(<template><InfoPanel /></template>);

    // Cycle enumeration runs in the resident Rust session; its test
    // waiter makes `render()` block until it resolves.
    assert.dom(".panel__cycle").exists({ count: 1 });
    assert.dom(".panel__cycle-head-text").includesText("3 nodes");
    assert.dom(".cycle-id").exists("cycle entry has its short-id chip");
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

    // Hide files so the cycle contracts to pkgA → pkgB → pkgA. Each
    // bundled step should expose its underlying raw file label.
    const fileType = g.nodeTypeNames.indexOf("file");

    viewState(this.owner).toggleHiddenNodeType(fileType);
    viewState(this.owner).selectedId = "pkgA";

    await render(<template><InfoPanel /></template>);

    assert.dom(".panel__cycle").exists({ count: 1 }, "one bundled cycle through pkgA");
    assert.dom(".panel__neighbor-raw").exists("raw-file line surfaces under contracted steps");
  });

  test("internal cycles toggle surfaces file-level cycles within the selected package", async function (assert) {
    // pkg owns three files that form a 3-cycle entirely inside the
    // package. With files hidden globally, no bundled cycle passes
    // through `pkg` (its loops are absorbed). The internal-cycles
    // toggle is the user's escape hatch: click it and the panel shows
    // the file-level loop verbatim.
    const g = loadGraph(this.owner, {
      nodes: [
        { id: "pkg", type: "package", edges: ["f1", "f2", "f3"] },
        { id: "f1", type: "file", edges: ["f2"] },
        { id: "f2", type: "file", edges: ["f3"] },
        { id: "f3", type: "file", edges: ["f1"] },
      ],
    });
    const fileType = g.nodeTypeNames.indexOf("file");

    viewState(this.owner).toggleHiddenNodeType(fileType);
    viewState(this.owner).selectedId = "pkg";

    await render(<template><InfoPanel /></template>);

    // Default mode: pkg sits on no cross-package cycle (the only loop
    // is fully inside it), so the main list is empty…
    assert.dom(".panel__cycle").doesNotExist("no cross-package cycles for this lone-package graph");

    // …but the toggle button advertises the hidden internal cycle.
    const toggleSelector = ".info-panel .panel__subhead-action";
    const beforeText = Array.from(document.querySelectorAll(toggleSelector))
      .map((el) => el.textContent ?? "")
      .join(" ");

    assert.ok(/internal/i.test(beforeText), "internal-cycles toggle button appears");
    assert.ok(/hidden/i.test(beforeText), 'the toggle marks them as currently "hidden"');

    // Find and click the internal-mode toggle (not "Collapse all").
    const toggleBtn = Array.from(document.querySelectorAll(toggleSelector)).find((el) =>
      /internal/i.test(el.textContent ?? ""),
    ) as HTMLButtonElement | undefined;

    assert.ok(toggleBtn, "found the internal-cycles toggle button");
    await click(toggleBtn!);

    // After the click the file cycle f1 → f2 → f3 → f1 should show.
    assert.dom(".panel__cycle").exists({ count: 1 }, "internal mode reveals the file-level cycle");
    assert.dom(".panel__cycle-head-text").includesText("3 nodes", "the 3-file cycle is intact");
  });

  test("section open/closed state survives navigating between cycle nodes", async function (assert) {
    // a → b → c → a is the cycle. `a` also gets 21 extra incoming
    // edges so its `in` section auto-collapses (count 22 > the 20
    // threshold); `b`'s `in` count is 1, which would auto-open.
    const fillers = Array.from({ length: 21 }, (_, i) => ({
      id: `f${i}`,
      edges: ["a"],
    }));

    loadGraph(this.owner, {
      nodes: [
        { id: "a", edges: ["b"] },
        { id: "b", edges: ["c"] },
        { id: "c", edges: ["a"] },
        ...fillers,
      ],
    });
    viewState(this.owner).selectedId = "a";

    // Cycle enumeration runs in the resident Rust session; its test
    // waiter makes `render()` block until it resolves.
    await render(<template><InfoPanel /></template>);

    const section = (label: string): Element => {
      const el = findAll(".panel__section").find((s) =>
        s.querySelector(".panel__subhead")?.textContent?.trim().startsWith(label),
      );

      if (!el) throw new Error(`no "${label}" section`);

      return el;
    };

    const isOpen = (label: string): boolean => section(label).hasAttribute("open");
    const summary = (label: string): Element => {
      const el = section(label).querySelector(".panel__subhead");

      if (!el) throw new Error(`no "${label}" summary`);

      return el;
    };

    // Preconditions: `a` has 22 incoming → `in` auto-collapsed; the
    // single cycle is short → `cycles` auto-open.
    assert.false(isOpen("in"), "in section auto-collapses for the 22-in-edge node");
    assert.true(isOpen("cycles"), "cycles section auto-opens");

    // User explicitly collapses the cycles section.
    await click(summary("cycles"));
    assert.false(isOpen("cycles"), "cycles section now closed");

    // Click a node inside the cycle to view it (selection → "b").
    await click('.panel__cycle .panel__neighbor[title="b"]');
    assert.dom(".panel__title").hasText("b", "navigated to the clicked cycle node");

    // The regression: re-deriving open state from b's counts flipped
    // the untouched `in` section open and sprang the explicitly-closed
    // `cycles` section back open — the panel jumped. Both must hold.
    assert.false(isOpen("in"), "in section stays collapsed after navigating");
    assert.false(isOpen("cycles"), "explicitly-closed cycles section stays closed");
  });

  test("double-clicking a neighbor row selects the node and asks the canvas to zoom in", async function (assert) {
    loadGraph(this.owner, {
      nodes: [
        { id: "src", label: "Src", edges: ["target"] },
        { id: "target", label: "Target", edges: ["sink"] },
        { id: "sink", label: "Sink" },
      ],
    });
    viewState(this.owner).selectedId = "target";

    const vis = this.owner.lookup("service:visualizer") as VisualizerService;

    await render(<template><InfoPanel /></template>);

    assert.strictEqual(vis.pendingFocus, null, "no focus request pending before interaction");

    await triggerEvent('.panel__neighbor[title="sink"]', "dblclick");

    assert.strictEqual(viewState(this.owner).selectedId, "sink", "selection followed the dblclick");
    assert.strictEqual(vis.pendingFocus?.id, "sink", "canvas focus targets the same node");
    assert.true(vis.pendingFocus?.zoomIn, "request is the zoom-in variant, not a plain recenter");
  });
});
