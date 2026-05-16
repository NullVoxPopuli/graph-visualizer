import { module, test } from "qunit";

import { findOrphans, hasAnyOrphan } from "#lib/orphans";
import { cycleToIds, makeGraph } from "#test-helpers/graph";

module("Unit | lib/orphans | findOrphans", () => {
  test("empty graph returns no orphans", (assert) => {
    assert.deepEqual(findOrphans(makeGraph({ nodes: [] })), []);
  });

  test("a linear DAG is entirely orphans (Kahn peels every node)", (assert) => {
    const g = makeGraph({
      nodes: [{ id: "src", edges: ["mid"] }, { id: "mid", edges: ["sink"] }, { id: "sink" }],
    });

    assert.deepEqual(cycleToIds(g, findOrphans(g)).sort(), ["mid", "sink", "src"]);
  });

  test("a pure cycle has no orphans", (assert) => {
    const g = makeGraph({
      nodes: [
        { id: "a", edges: ["b"] },
        { id: "b", edges: ["a"] },
      ],
    });

    assert.deepEqual(findOrphans(g), []);
  });

  test("a node feeding into a cycle is an orphan; cycle members are not", (assert) => {
    const g = makeGraph({
      nodes: [
        { id: "src", edges: ["a"] },
        { id: "a", edges: ["b"] },
        { id: "b", edges: ["a"] },
      ],
    });

    assert.deepEqual(cycleToIds(g, findOrphans(g)), ["src"]);
  });

  test("hiding an edge type that breaks a cycle exposes more orphans", (assert) => {
    const g = makeGraph({
      nodes: [
        { id: "a", edges: [{ nodeId: "b", edgeType: "test" }] },
        { id: "b", edges: [{ nodeId: "a", edgeType: "test" }] },
      ],
    });

    // No filter: a-b cycle, no orphans.
    assert.deepEqual(findOrphans(g), []);

    // Hide "test": both nodes lose all edges, both become orphans.
    const testType = g.edgeTypeNames.indexOf("test");
    const filtered = findOrphans(g, new Set([testType]));

    assert.deepEqual(cycleToIds(g, filtered).sort(), ["a", "b"]);
  });

  test("hiddenEdgeTypes affects in-degree but `findOrphans` always reads visible edges", (assert) => {
    // Without filter: a is orphan (no incoming), b is not (incoming from a + c).
    // After peel: a out, b in-deg drops to 1, then c (orphan) out, b in-deg drops to 0 → orphan.
    const g = makeGraph({
      nodes: [{ id: "a", edges: ["b"] }, { id: "b" }, { id: "c", edges: ["b"] }],
    });
    const orphans = findOrphans(g);

    // a, c, b — all peelable.
    assert.deepEqual(cycleToIds(g, orphans).sort(), ["a", "b", "c"]);
  });
});

module("Unit | lib/orphans | hasAnyOrphan", () => {
  test("empty graph: false", (assert) => {
    assert.false(hasAnyOrphan(makeGraph({ nodes: [] })));
  });

  test("any in-degree-0 node makes it true (fast path)", (assert) => {
    const g = makeGraph({
      nodes: [
        { id: "src", edges: ["a"] },
        { id: "a", edges: ["src"] }, // cycle
      ],
    });

    // src in-deg = 1, a in-deg = 1; both in cycle.
    assert.false(hasAnyOrphan(g));
  });

  test("isolated node (no edges anywhere) is reported as orphan", (assert) => {
    const g = makeGraph({
      nodes: [{ id: "alone" }, { id: "a", edges: ["b"] }, { id: "b", edges: ["a"] }],
    });

    assert.true(hasAnyOrphan(g));
  });

  test("edge-type filter (slow path) and unfiltered (fast path) agree on a simple graph", (assert) => {
    const g = makeGraph({
      nodes: [
        { id: "a", edges: ["b"] },
        { id: "b", edges: ["a"] },
      ],
    });

    assert.false(hasAnyOrphan(g));
    assert.false(hasAnyOrphan(g, new Set())); // empty filter == fast path

    // Hide untyped (the default edge type) — every edge vanishes, both become orphans.
    const untypedId = g.edgeTypeNames.indexOf("");

    assert.true(hasAnyOrphan(g, new Set([untypedId])));
  });
});
