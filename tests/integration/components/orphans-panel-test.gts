import { render, rerender, settled, triggerEvent, waitFor } from "@ember/test-helpers";
import { module, test } from "qunit";
import { setupRenderingTest } from "ember-qunit";

import OrphansPanel from "#components/orphans-panel";
import { loadGraph, stubRouterTransitions, viewState } from "#test-helpers/render";

import type VisualizerService from "#services/visualizer";

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

  test("keeps the previous orphan list visible while a re-query is in flight", async function (assert) {
    const g = loadGraph(this.owner, {
      nodes: [{ id: "alone" }, { id: "a", edges: ["b"] }, { id: "b", edges: ["a"] }],
    });
    const aloneIdx = g.idToIndex.get("alone");

    if (aloneIdx === undefined) throw new Error("fixture missing 'alone'");

    const vis = this.owner.lookup("service:visualizer") as VisualizerService;

    // Stable promise identities (the real service memoizes by content
    // key — `getPromiseState` caches off identity). No declared roots →
    // resolves to the orphan; once a root is declared → a deferred we
    // hold open, standing in for the in-flight re-query. (`getPromiseState`
    // wraps promises in a test waiter, so it must eventually resolve or
    // `settled()` would hang — we release it after asserting.)
    const resolved = Promise.resolve(Int32Array.from([aloneIdx]));
    let release!: (v: Int32Array) => void;
    const deferred = new Promise<Int32Array>((res) => (release = res));

    vis.orphanIndices = (_hidden: Int32Array, roots: Int32Array): Promise<Int32Array> =>
      roots.length === 0 ? resolved : deferred;

    viewState(this.owner).orphansPanelOpen = true;

    await render(<template><OrphansPanel /></template>);
    await waitFor(".cycles-panel__node-label");
    assert.dom(".cycles-panel__node-label").hasText("alone", "orphan listed initially");

    // Declaring a root re-runs the orphan query — now in flight. Flush a
    // render pass *without* settling (settling would block on the
    // deferred's test waiter and defeat observing the pending window).
    viewState(this.owner).toggleRootNodeId("a");
    await rerender();

    assert
      .dom(".cycles-panel__node-label")
      .hasText("alone", "previous list kept while the re-query is in flight");
    assert.dom(".cycles-panel__empty").doesNotExist("no empty-state flash during the async gap");

    // Let the query finish so the test-waiter clears for teardown.
    release(Int32Array.from([aloneIdx]));
    await settled();
  });

  test("double-clicking an orphan row selects the node and asks the canvas to zoom in", async function (assert) {
    loadGraph(this.owner, {
      nodes: [{ id: "alone" }, { id: "a", edges: ["b"] }, { id: "b", edges: ["a"] }],
    });
    viewState(this.owner).orphansPanelOpen = true;

    const vis = this.owner.lookup("service:visualizer") as VisualizerService;

    await render(<template><OrphansPanel /></template>);
    await waitFor(".cycles-panel__node-label");

    // Plain selection from the panel opening doesn't queue a focus
    // request — only the explicit dblclick should.
    assert.strictEqual(vis.pendingFocus, null, "no focus request pending before interaction");

    await triggerEvent('.cycles-panel__node[title="alone"]', "dblclick");

    assert.strictEqual(
      viewState(this.owner).selectedId,
      "alone",
      "selection followed the dblclick",
    );
    assert.strictEqual(vis.pendingFocus?.id, "alone", "canvas focus targets the same node");
    assert.true(vis.pendingFocus?.zoomIn, "request is the zoom-in variant, not a plain recenter");
  });
});
