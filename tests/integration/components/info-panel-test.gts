import { render } from "@ember/test-helpers";
import { module, test } from "qunit";
import { setupRenderingTest } from "ember-qunit";

import InfoPanel from "#components/info-panel";
import { loadGraph, stubRouterTransitions, viewState } from "#test-helpers/render";

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
});
