import { module, test } from "qunit";
import { setupTest } from "ember-qunit";

import { makeGraph } from "#test-helpers/graph";
import { stubRouterTransitions } from "#test-helpers/render";

import type ViewStateService from "#services/view-state";

function viewState(owner: { lookup(name: string): unknown }): ViewStateService {
  return owner.lookup("service:view-state") as ViewStateService;
}

module("Integration | service:view-state | query-param round-tripping", function (hooks) {
  setupTest(hooks);

  hooks.beforeEach(function () {
    stubRouterTransitions(this.owner);
  });

  test("boolean toggles default in their on/off direction", function (assert) {
    const vs = viewState(this.owner);

    assert.true(vs.showEdges, "edges default ON");
    assert.true(vs.showArrows, "arrows default ON");
    assert.false(vs.showHulls, "hulls default OFF");
    assert.true(vs.controlsOpen, "controls default OPEN");
    assert.false(vs.cyclesPanelOpen, "cycles panel default CLOSED");
    assert.false(vs.orphansPanelOpen, "orphans panel default CLOSED");
  });

  test("boolean toggles round-trip through the setter", function (assert) {
    const vs = viewState(this.owner);

    vs.showEdges = false;
    assert.false(vs.showEdges, "edges toggled OFF");

    vs.showEdges = true;
    assert.true(vs.showEdges, "edges toggled back ON");

    vs.cyclesPanelOpen = true;
    assert.true(vs.cyclesPanelOpen);

    vs.orphansPanelOpen = true;
    assert.true(vs.orphansPanelOpen);
  });

  test("hiddenEdgeTypes toggles add and remove members", function (assert) {
    const vs = viewState(this.owner);

    assert.strictEqual(vs.hiddenEdgeTypes.size, 0, "empty by default");

    vs.toggleHiddenEdgeType(3);
    assert.true(vs.hiddenEdgeTypes.has(3), "first toggle adds");

    vs.toggleHiddenEdgeType(5);
    assert.deepEqual([...vs.hiddenEdgeTypes].sort(), [3, 5]);

    vs.toggleHiddenEdgeType(3);
    assert.false(vs.hiddenEdgeTypes.has(3), "second toggle removes");
    assert.true(vs.hiddenEdgeTypes.has(5), "other members untouched");
  });

  test("hiddenNodeTypes follows the same toggle semantics", function (assert) {
    const vs = viewState(this.owner);

    vs.toggleHiddenNodeType(1);
    vs.toggleHiddenNodeType(2);

    assert.deepEqual([...vs.hiddenNodeTypes].sort(), [1, 2]);
  });

  test("hiddenNodeIds round-trips via toggleHiddenNodeId / clearHiddenNodes", function (assert) {
    const vs = viewState(this.owner);

    vs.toggleHiddenNodeId("foo");
    vs.toggleHiddenNodeId("bar");

    assert.deepEqual([...vs.hiddenNodeIds].sort(), ["bar", "foo"]);

    vs.toggleHiddenNodeId("foo");
    assert.deepEqual([...vs.hiddenNodeIds], ["bar"], "second toggle removes");

    vs.clearHiddenNodes();
    assert.strictEqual(vs.hiddenNodeIds.size, 0);
  });

  test("collapsedIds round-trip via toggleCollapsed / clearCollapsed", function (assert) {
    const vs = viewState(this.owner);

    vs.toggleCollapsed("pkg/a");
    assert.true(vs.collapsedIds.has("pkg/a"));

    vs.toggleCollapsed("pkg/a");
    assert.false(vs.collapsedIds.has("pkg/a"), "second toggle removes");

    vs.toggleCollapsed("pkg/b");
    vs.clearCollapsed();
    assert.strictEqual(vs.collapsedIds.size, 0);
  });

  test("numeric layout sliders default and round-trip", function (assert) {
    const vs = viewState(this.owner);

    assert.strictEqual(vs.repulsion, 6, "default repulsion");
    assert.strictEqual(vs.nodeDistance, 18, "default nodeDistance");
    assert.strictEqual(vs.clusterDistance, 180, "default clusterDistance");
    assert.strictEqual(vs.clustering, 1, "default clustering");

    vs.repulsion = 14;
    vs.nodeDistance = 40;
    vs.clusterDistance = 300;
    vs.clustering = 1.5;

    assert.strictEqual(vs.repulsion, 14);
    assert.strictEqual(vs.nodeDistance, 40);
    assert.strictEqual(vs.clusterDistance, 300);
    assert.strictEqual(vs.clustering, 1.5);
  });

  test("info-section overrides accept tri-state (true/false/null)", function (assert) {
    const vs = viewState(this.owner);

    assert.strictEqual(vs.infoInOpenOverride, null, "no override by default");

    vs.infoInOpenOverride = true;
    assert.true(vs.infoInOpenOverride);

    vs.infoInOpenOverride = false;
    assert.false(vs.infoInOpenOverride, "false is sticky, distinct from null");

    vs.infoInOpenOverride = null;
    assert.strictEqual(vs.infoInOpenOverride, null, "null clears the override");
  });

  test("selectedId round-trips strings + null", function (assert) {
    const vs = viewState(this.owner);

    assert.strictEqual(vs.selectedId, null);

    vs.selectedId = "node-a";
    assert.strictEqual(vs.selectedId, "node-a");

    vs.selectedId = null;
    assert.strictEqual(vs.selectedId, null);
  });

  test("addIncludeGlob deduplicates and removeIncludeGlob clears one entry", function (assert) {
    const vs = viewState(this.owner);

    vs.addIncludeGlob("src/*");
    vs.addIncludeGlob("test/*");
    vs.addIncludeGlob("src/*"); // duplicate — no-op

    assert.deepEqual(vs.includeGlobs, ["src/*", "test/*"]);

    vs.removeIncludeGlob("src/*");
    assert.deepEqual(vs.includeGlobs, ["test/*"]);
  });

  test("addIncludeGlob rejects empty / `|`-containing inputs silently", function (assert) {
    const vs = viewState(this.owner);

    vs.addIncludeGlob("");
    vs.addIncludeGlob("   ");
    vs.addIncludeGlob("foo|bar");

    assert.deepEqual(vs.includeGlobs, [], "all rejected by normalizeGlobInput");
  });
});

module("Integration | service:view-state | effectiveHiddenNodeIds", function (hooks) {
  setupTest(hooks);

  hooks.beforeEach(function () {
    stubRouterTransitions(this.owner);
  });

  test("returns the original `hiddenNodeIds` set when no globs are configured", function (assert) {
    const vs = viewState(this.owner);
    const g = makeGraph({ nodes: [{ id: "a" }, { id: "b" }] });

    vs.toggleHiddenNodeId("a");

    // Fast path: same reference as the base set when nothing to merge.
    const eff = vs.effectiveHiddenNodeIds(g);

    assert.deepEqual([...eff], ["a"]);
  });

  test("include glob hides labels that don't match", function (assert) {
    const vs = viewState(this.owner);
    const g = makeGraph({
      nodes: [{ id: "src/foo.ts" }, { id: "test/bar.ts" }, { id: "src/baz.ts" }],
    });

    vs.addIncludeGlob("src/*");

    const eff = vs.effectiveHiddenNodeIds(g);

    assert.true(eff.has("test/bar.ts"), "test file: filtered out (no include match)");
    assert.false(eff.has("src/foo.ts"), "src file: passes include");
    assert.false(eff.has("src/baz.ts"), "src file: passes include");
  });

  test("exclude glob hides labels that match", function (assert) {
    const vs = viewState(this.owner);
    const g = makeGraph({
      nodes: [{ id: "foo.ts" }, { id: "foo.test.ts" }],
    });

    vs.addExcludeGlob("*.test.ts");

    const eff = vs.effectiveHiddenNodeIds(g);

    assert.true(eff.has("foo.test.ts"));
    assert.false(eff.has("foo.ts"));
  });

  test("exclude wins over include", function (assert) {
    const vs = viewState(this.owner);
    const g = makeGraph({
      nodes: [{ id: "src/foo.ts" }, { id: "src/foo.test.ts" }],
    });

    vs.addIncludeGlob("src/*");
    vs.addExcludeGlob("*.test.ts");

    const eff = vs.effectiveHiddenNodeIds(g);

    assert.true(eff.has("src/foo.test.ts"), "matches both include AND exclude — exclude wins");
    assert.false(eff.has("src/foo.ts"), "matches include only — visible");
  });

  test("explicit hiddenNodeIds union with glob-filtered ids", function (assert) {
    const vs = viewState(this.owner);
    const g = makeGraph({
      nodes: [{ id: "src/foo.ts" }, { id: "src/bar.ts" }, { id: "test/baz.ts" }],
    });

    // Hide one src/ file explicitly, then add an exclude that drops the test/.
    vs.toggleHiddenNodeId("src/foo.ts");
    vs.addExcludeGlob("test/*");

    const eff = vs.effectiveHiddenNodeIds(g);

    assert.deepEqual([...eff].sort(), ["src/foo.ts", "test/baz.ts"]);
  });
});
