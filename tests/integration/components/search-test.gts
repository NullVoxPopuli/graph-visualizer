import { fillIn, focus, render, triggerEvent, triggerKeyEvent } from "@ember/test-helpers";
import { module, test } from "qunit";
import { setupRenderingTest } from "ember-qunit";

import Search from "#components/search";
import { loadGraph, stubRouterTransitions, viewState } from "#test-helpers/render";

module("Integration | search", function (hooks) {
  setupRenderingTest(hooks);

  hooks.beforeEach(function () {
    stubRouterTransitions(this.owner);
  });

  test("renders the input even when no graph is loaded", async function (assert) {
    await render(<template><Search /></template>);

    assert.dom(".search__input").exists();
  });

  test("typing fewer than the minimum required chars shows a hint", async function (assert) {
    loadGraph(this.owner, {
      nodes: [{ id: "foo" }, { id: "bar" }],
    });

    await render(<template><Search /></template>);
    await focus(".search__input");
    await fillIn(".search__input", "fo");

    assert.dom(".search__results").doesNotExist("no result list under the threshold");
    assert.dom(".search__hint").includesText("Type at least", "hint surfaces the threshold");
  });

  test("typing a matching query renders ranked results", async function (assert) {
    loadGraph(this.owner, {
      nodes: [
        { id: "alpha" },
        { id: "alphabet" },
        { id: "ghost" }, // contains 'ha' as substring
      ],
    });

    await render(<template><Search /></template>);
    await focus(".search__input");
    await fillIn(".search__input", "alph");

    // Both `alpha` and `alphabet` start with the query, so they rank first.
    assert.dom(".search__results").exists();

    const labels = Array.from(document.querySelectorAll(".search__result-label")).map(
      (el) => el.textContent ?? "",
    );

    assert.true(labels.includes("alpha"));
    assert.true(labels.includes("alphabet"));
  });

  test("shows the no-matches hint when the query has the minimum length but no hits", async function (assert) {
    loadGraph(this.owner, {
      nodes: [{ id: "alpha" }, { id: "beta" }],
    });

    await render(<template><Search /></template>);
    await focus(".search__input");
    await fillIn(".search__input", "zzz");

    assert.dom(".search__results").doesNotExist();
    assert.dom(".search__hint").includesText("No matches");
  });

  test("clicking a result selects that node via the view-state service", async function (assert) {
    loadGraph(this.owner, {
      nodes: [{ id: "alpha" }, { id: "beta" }],
    });

    await render(<template><Search /></template>);
    await focus(".search__input");
    await fillIn(".search__input", "alph");
    // The component listens to mousedown (so it fires before blur drops
    // the list). `triggerEvent` lets us dispatch a mousedown directly
    // without the click() helper.
    await triggerEvent(".search__result", "mousedown");

    assert.strictEqual(viewState(this.owner).selectedId, "alpha");
  });

  test("ArrowDown / ArrowUp move the focused row; Enter selects it", async function (assert) {
    loadGraph(this.owner, {
      nodes: [{ id: "alpha" }, { id: "alphabet" }],
    });

    await render(<template><Search /></template>);
    await focus(".search__input");
    await fillIn(".search__input", "alph");

    await triggerKeyEvent(".search__input", "keydown", "ArrowDown");
    assert.dom(".search__result.is-focused").exists({ count: 1 }, "ArrowDown focuses one row");

    await triggerKeyEvent(".search__input", "keydown", "ArrowDown");
    // Second ArrowDown moves down — the focused row's label should now
    // be the second result. The component's `matches` order is starts-
    // with first, so the second match is `alphabet`.
    assert.dom(".search__result.is-focused .search__result-label").hasText("alphabet");

    await triggerKeyEvent(".search__input", "keydown", "ArrowUp");
    assert
      .dom(".search__result.is-focused .search__result-label")
      .hasText("alpha", "ArrowUp moves back");

    await triggerKeyEvent(".search__input", "keydown", "Enter");

    assert.strictEqual(
      viewState(this.owner).selectedId,
      "alpha",
      "Enter selects the focused row's id",
    );
  });

  test("Escape closes the dropdown without selecting", async function (assert) {
    loadGraph(this.owner, {
      nodes: [{ id: "alpha" }],
    });

    await render(<template><Search /></template>);
    await focus(".search__input");
    await fillIn(".search__input", "alph");

    assert.dom(".search__results").exists("dropdown open");

    await triggerKeyEvent(".search__input", "keydown", "Escape");

    assert.dom(".search__results").doesNotExist("dropdown closed after Escape");
    assert.strictEqual(viewState(this.owner).selectedId, null, "no selection set");
  });
});
