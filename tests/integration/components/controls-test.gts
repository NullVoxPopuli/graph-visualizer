import { click, fillIn, render, triggerEvent } from "@ember/test-helpers";
import { module, test } from "qunit";
import { setupRenderingTest } from "ember-qunit";

import Controls from "#components/controls";
import { loadGraph, stubRouterTransitions, viewState } from "#test-helpers/render";

const NOOP = (): void => {
  /* test stub for `@onResetView` */
};

module("Integration | controls", function (hooks) {
  setupRenderingTest(hooks);

  hooks.beforeEach(function () {
    stubRouterTransitions(this.owner);
  });

  test("shows the cycle-status footer when a graph is loaded", async function (assert) {
    loadGraph(this.owner, {
      nodes: [{ id: "a" }, { id: "b" }],
    });

    await render(<template><Controls @onResetView={{NOOP}} /></template>);

    assert.dom(".controls__cycles-status").includesText("no cycles");
  });

  test("reports a cycle in the footer when one exists", async function (assert) {
    loadGraph(this.owner, {
      nodes: [
        { id: "a", edges: ["b"] },
        { id: "b", edges: ["a"] },
      ],
    });

    await render(<template><Controls @onResetView={{NOOP}} /></template>);

    assert.dom(".controls__cycles-status").includesText("at least one cycle");
  });

  test("edge-type filters list each distinct edge type with its count", async function (assert) {
    loadGraph(this.owner, {
      nodes: [
        { id: "a", edges: [{ nodeId: "b", edgeType: "calls" }] },
        {
          id: "b",
          edges: [
            { nodeId: "c", edgeType: "calls" },
            { nodeId: "a", edgeType: "test" },
          ],
        },
        { id: "c" },
      ],
    });

    await render(<template><Controls @onResetView={{NOOP}} /></template>);

    const names = Array.from(document.querySelectorAll(".controls__type-name")).map(
      (el) => el.textContent?.trim() ?? "",
    );

    assert.true(names.includes("calls"), `expected "calls" in ${JSON.stringify(names)}`);
    assert.true(names.includes("test"), `expected "test" in ${JSON.stringify(names)}`);
  });

  test("adding an include-label glob persists it in viewState", async function (assert) {
    loadGraph(this.owner, {
      nodes: [{ id: "src/foo.ts" }, { id: "test/bar.ts" }],
    });

    await render(<template><Controls @onResetView={{NOOP}} /></template>);

    // The first form within `.controls__filter-group` belongs to the
    // include list (filter groups are: edge types?, include labels,
    // exclude labels — when no edge types are present, include is
    // first). For this graph there are no edge types, so the first
    // form is `include`.
    await fillIn(".controls__filter-group:nth-of-type(1) .controls__glob-input", "src/*");
    await triggerEvent(".controls__filter-group:nth-of-type(1) .controls__glob-form", "submit");

    assert.deepEqual(viewState(this.owner).includeGlobs, ["src/*"]);
    assert.dom(".controls__glob-pattern").includesText("src/*");
  });

  test("removing a glob via the × button updates viewState", async function (assert) {
    loadGraph(this.owner, {
      nodes: [{ id: "a" }, { id: "b" }],
    });
    // Seed an include glob before render so the row exists.
    viewState(this.owner).addIncludeGlob("foo/*");

    await render(<template><Controls @onResetView={{NOOP}} /></template>);

    assert.dom(".controls__glob-pattern").includesText("foo/*");

    await click(".controls__glob-remove");

    assert.deepEqual(viewState(this.owner).includeGlobs, []);
    assert.dom(".controls__glob").doesNotExist();
  });

  test("the 'Show cycles' button appears only when the graph has cycles", async function (assert) {
    loadGraph(this.owner, {
      nodes: [{ id: "a", edges: ["b"] }, { id: "b" }],
    });

    await render(<template><Controls @onResetView={{NOOP}} /></template>);

    // DAG → no cycles button.
    assert.dom("button").exists();
    assert.false(
      Array.from(document.querySelectorAll("button")).some((b) =>
        (b.textContent ?? "").includes("Show cycles"),
      ),
      "no 'Show cycles' button on a DAG",
    );

    // Add a cycle: load a new graph with one and re-render.
    loadGraph(this.owner, {
      nodes: [
        { id: "a", edges: ["b"] },
        { id: "b", edges: ["a"] },
      ],
    });

    await render(<template><Controls @onResetView={{NOOP}} /></template>);

    assert.true(
      Array.from(document.querySelectorAll("button")).some((b) =>
        (b.textContent ?? "").includes("Show cycles"),
      ),
      "'Show cycles' button visible when a cycle exists",
    );
  });
});
