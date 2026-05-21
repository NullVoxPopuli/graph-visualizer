import { module, test } from "qunit";

import { clusterByLcp, extractClusterStrings, isClusterMode } from "#lib/cluster";
import { makeGraph } from "#test-helpers/graph";

module("Unit | lib/cluster | isClusterMode", () => {
  test("recognizes the fixed mode strings", (assert) => {
    assert.true(isClusterMode("id"));
    assert.true(isClusterMode("label"));
    assert.true(isClusterMode("type"));
  });

  test("recognizes meta paths with at least one segment", (assert) => {
    assert.true(isClusterMode("meta.team"));
    assert.true(isClusterMode("meta.layer.tier"));
    assert.false(isClusterMode("meta"));
    assert.false(isClusterMode("meta."));
  });

  test("treats null, empty, and unknown strings as no-mode (→ Louvain)", (assert) => {
    assert.false(isClusterMode(null));
    assert.false(isClusterMode(""));
    assert.false(isClusterMode("louvain"));
    assert.false(isClusterMode("foo"));
  });
});

module("Unit | lib/cluster | clusterByLcp", () => {
  test("groups strings that share a longest non-zero prefix with a neighbour", (assert) => {
    // Two natural prefix groups; the algorithm should find them
    // without any hard-coded `/` separator.
    const ids = clusterByLcp(["@acme/utils", "@acme/db", "@acme/auth", "@beta/x", "@beta/y"]);

    // First three share `@acme/`, last two share `@beta/`.
    assert.strictEqual(ids[0], ids[1], "@acme/utils and @acme/db cluster together");
    assert.strictEqual(ids[1], ids[2], "@acme/db and @acme/auth cluster together");
    assert.strictEqual(ids[3], ids[4], "@beta/x and @beta/y cluster together");
    assert.notStrictEqual(ids[0], ids[3], "the two @-prefix groups are distinct clusters");
  });

  test("a string with no shared prefix with anyone stays alone", (assert) => {
    // Bar and Baz share `Ba`; Foo shares nothing with them.
    const ids = clusterByLcp(["Foo", "Bar", "Baz"]);

    assert.strictEqual(ids[1], ids[2], "Bar and Baz cluster together (`Ba`)");
    assert.notStrictEqual(ids[0], ids[1], "Foo is its own cluster (no prefix with Bar/Baz)");
  });

  test("identical strings always cluster together", (assert) => {
    const ids = clusterByLcp(["x", "x", "x"]);

    assert.strictEqual(ids[0], ids[1]);
    assert.strictEqual(ids[1], ids[2]);
  });

  test("empty input returns an empty Int32Array", (assert) => {
    const ids = clusterByLcp([]);

    assert.strictEqual(ids.length, 0);
  });

  test("single-element input yields one cluster", (assert) => {
    const ids = clusterByLcp(["only"]);

    assert.strictEqual(ids.length, 1);
    assert.strictEqual(ids[0], 0);
  });
});

module("Unit | lib/cluster | extractClusterStrings", () => {
  test("mode=id returns each node's id", (assert) => {
    const g = makeGraph({
      nodes: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    });
    const ids = extractClusterStrings(g, "id");

    assert.deepEqual(ids, ["a", "b"]);
  });

  test("mode=label returns each node's label", (assert) => {
    const g = makeGraph({
      nodes: [
        { id: "x", label: "alpha" },
        { id: "y", label: "beta" },
      ],
    });

    assert.deepEqual(extractClusterStrings(g, "label"), ["alpha", "beta"]);
  });

  test("mode=type returns the node type name", (assert) => {
    const g = makeGraph({
      nodes: [
        { id: "a", type: "package" },
        { id: "b", type: "package" },
        { id: "c", type: "file" },
      ],
    });
    const out = extractClusterStrings(g, "type");

    assert.strictEqual(out[0], "package");
    assert.strictEqual(out[1], "package");
    assert.strictEqual(out[2], "file");
  });

  test("mode=meta.x reads the per-node meta value", (assert) => {
    // makeGraph passes `meta` through to the parser; the parser
    // stores it on `graph.metas[i]` verbatim.
    const g = makeGraph({
      nodes: [
        { id: "a", meta: { team: "infra" } },
        { id: "b", meta: { team: "infra" } },
        { id: "c", meta: { team: "ui" } },
      ],
    });
    const out = extractClusterStrings(g, "meta.team");

    assert.strictEqual(out[0], "infra");
    assert.strictEqual(out[1], "infra");
    assert.strictEqual(out[2], "ui");
  });

  test("mode=meta.x.y walks nested paths", (assert) => {
    const g = makeGraph({
      nodes: [
        { id: "a", meta: { layer: { tier: "edge" } } },
        { id: "b", meta: { layer: { tier: "core" } } },
      ],
    });
    const out = extractClusterStrings(g, "meta.layer.tier");

    assert.deepEqual(out, ["edge", "core"]);
  });

  test("missing meta path resolves all such nodes to the same sentinel", (assert) => {
    const g = makeGraph({
      nodes: [
        { id: "a", meta: { team: "infra" } }, //
        { id: "b" }, // no meta
        { id: "c", meta: {} }, // meta but no `team`
      ],
    });
    const out = extractClusterStrings(g, "meta.team");

    assert.strictEqual(out[0], "infra");
    assert.strictEqual(out[1], out[2], "both unresolved nodes share the same sentinel string");
    assert.notStrictEqual(out[1], "infra", "the sentinel isn't a valid value");

    // …and the LCP clusterer collapses them into one bucket:
    const clustered = clusterByLcp(out);

    assert.notStrictEqual(clustered[0], clustered[1], "infra ≠ missing-bucket");
    assert.strictEqual(clustered[1], clustered[2], "both missing nodes share a cluster");
  });
});
