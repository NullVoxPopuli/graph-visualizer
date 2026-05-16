import { module, test } from "qunit";

import { collapseList, toggleInSet } from "#lib/collapse-list";

module("Unit | lib/collapse-list | collapseList", () => {
  test("empty list collapses to all-empty", (assert) => {
    assert.deepEqual(collapseList([], false), { head: [], hiddenCount: 0, tail: [] });
  });

  test("lists of 5 or fewer never collapse", (assert) => {
    const items = [1, 2, 3, 4, 5];
    const out = collapseList(items, false);

    assert.deepEqual(out.head, items);
    assert.strictEqual(out.hiddenCount, 0);
    assert.deepEqual(out.tail, []);
  });

  test("expanded:true bypasses the collapse regardless of length", (assert) => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const out = collapseList(items, true);

    assert.deepEqual(out.head, items);
    assert.strictEqual(out.hiddenCount, 0);
    assert.deepEqual(out.tail, []);
  });

  test("6+ items collapse to head=2 / hiddenCount=N-3 / tail=1", (assert) => {
    const out = collapseList([1, 2, 3, 4, 5, 6], false);

    assert.deepEqual(out.head, [1, 2]);
    assert.strictEqual(out.hiddenCount, 3);
    assert.deepEqual(out.tail, [6]);
  });

  test("10 items: head=2, hidden=7, tail=1", (assert) => {
    const out = collapseList([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], false);

    assert.deepEqual(out.head, [1, 2]);
    assert.strictEqual(out.hiddenCount, 7);
    assert.deepEqual(out.tail, [10]);
  });
});

module("Unit | lib/collapse-list | toggleInSet", () => {
  test("adds an absent key", (assert) => {
    const a = new Set<string>(["x"]);
    const b = toggleInSet(a, "y");

    assert.true(b.has("y"));
    assert.true(b.has("x"));
  });

  test("removes a present key", (assert) => {
    const a = new Set<string>(["x", "y"]);
    const b = toggleInSet(a, "x");

    assert.false(b.has("x"));
    assert.true(b.has("y"));
  });

  test("returns a fresh Set (input is untouched)", (assert) => {
    const a = new Set<string>(["x"]);
    const b = toggleInSet(a, "y");

    assert.notStrictEqual(a, b);
    assert.false(a.has("y"), "input set unchanged");
  });
});
