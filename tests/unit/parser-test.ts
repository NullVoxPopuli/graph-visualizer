import { module, test } from "qunit";

import { parseGraphJson } from "#lib/parser";
import { SchemaError, validate } from "#lib/schema";

/**
 * Wrap `parseGraphJson` so tests don't pollute console with the
 * parser's warnings about dropped self-loops / unknown edges.
 */
function parseSilently(text: string): ReturnType<typeof parseGraphJson> {
  const originalWarn = console.warn;

  console.warn = (): void => {
    /* silence */
  };

  try {
    return parseGraphJson(text);
  } finally {
    console.warn = originalWarn;
  }
}

module("Unit | lib/schema | validate", () => {
  test("rejects non-object input", (assert) => {
    assert.throws(() => validate(null), SchemaError);
    assert.throws(() => validate(42), SchemaError);
    assert.throws(() => validate("foo"), SchemaError);
  });

  test("rejects missing `nodes` array", (assert) => {
    assert.throws(() => validate({}), SchemaError);
    assert.throws(() => validate({ nodes: "not an array" }), SchemaError);
  });

  test("rejects nodes that aren't objects", (assert) => {
    assert.throws(() => validate({ nodes: ["just a string"] }), SchemaError);
    assert.throws(() => validate({ nodes: [null] }), SchemaError);
  });

  test("requires every node to have an id", (assert) => {
    assert.throws(() => validate({ nodes: [{}] }), SchemaError);
    assert.throws(() => validate({ nodes: [{ id: null }] }), SchemaError);
  });

  test("id must be string or number", (assert) => {
    assert.throws(() => validate({ nodes: [{ id: true }] }), SchemaError);
    assert.throws(() => validate({ nodes: [{ id: { v: 1 } }] }), SchemaError);
  });

  test("optional fields are typed when present", (assert) => {
    assert.throws(() => validate({ nodes: [{ id: "a", label: 42 }] }), SchemaError);
    assert.throws(() => validate({ nodes: [{ id: "a", type: 1 }] }), SchemaError);
    assert.throws(() => validate({ nodes: [{ id: "a", edges: "nope" }] }), SchemaError);
  });

  test("edge object form requires nodeId + edgeType strings", (assert) => {
    assert.throws(
      () => validate({ nodes: [{ id: "a", edges: [{ nodeId: "b" }] }] }),
      SchemaError,
      "missing edgeType",
    );
    assert.throws(
      () => validate({ nodes: [{ id: "a", edges: [{ edgeType: "calls" }] }] }),
      SchemaError,
      "missing nodeId",
    );
    assert.throws(
      () => validate({ nodes: [{ id: "a", edges: [{ nodeId: true, edgeType: "x" }] }] }),
      SchemaError,
      "nodeId must be string|number",
    );
    assert.throws(
      () => validate({ nodes: [{ id: "a", edges: [{ nodeId: "b", edgeType: 42 }] }] }),
      SchemaError,
      "edgeType must be a string",
    );
  });

  test("edges can be plain string/number bare ids", (assert) => {
    // Doesn't throw — bare-id edge entries are valid.
    const result = validate({ nodes: [{ id: "a", edges: ["b", 7] }, { id: "b" }, { id: "7" }] });

    assert.deepEqual(result.nodes[0]?.edges, ["b", 7]);
  });
});

module("Unit | lib/parser | parseGraphJson", () => {
  test("invalid JSON throws SchemaError with the parse message", (assert) => {
    assert.throws(() => parseGraphJson("{ not valid"), SchemaError);
  });

  test("builds ids / labels / idToIndex from the input", (assert) => {
    const g = parseSilently(
      JSON.stringify({
        nodes: [
          { id: "alpha", label: "Alpha" },
          { id: "beta" }, // label defaults to id
        ],
      }),
    );

    assert.deepEqual(g.ids, ["alpha", "beta"]);
    assert.deepEqual(g.labels, ["Alpha", "beta"]);
    assert.strictEqual(g.idToIndex.get("alpha"), 0);
    assert.strictEqual(g.idToIndex.get("beta"), 1);
  });

  test("numeric ids are stringified", (assert) => {
    const g = parseSilently(JSON.stringify({ nodes: [{ id: 1 }, { id: 2 }] }));

    assert.deepEqual(g.ids, ["1", "2"]);
    assert.strictEqual(g.idToIndex.get("1"), 0);
  });

  test("duplicate node ids throw", (assert) => {
    assert.throws(
      () => parseSilently(JSON.stringify({ nodes: [{ id: "x" }, { id: "x" }] })),
      SchemaError,
    );
  });

  test("self-loop edges are dropped (force layout doesn't render them)", (assert) => {
    const g = parseSilently(
      JSON.stringify({
        nodes: [{ id: "a", edges: ["a", "b"] }, { id: "b" }],
      }),
    );

    // Only the `a → b` edge survives.
    assert.strictEqual(g.edgesFlat.length, 2);
    assert.strictEqual(g.edgesFlat[0], 0, "from = a");
    assert.strictEqual(g.edgesFlat[1], 1, "to = b");
  });

  test("edges referencing unknown ids are dropped", (assert) => {
    const g = parseSilently(
      JSON.stringify({
        nodes: [{ id: "a", edges: ["b", "ghost"] }, { id: "b" }],
      }),
    );

    // Only a → b kept; a → ghost dropped.
    assert.strictEqual(g.edgesFlat.length / 2, 1);
  });

  test("duplicate (from, to) edge pairs are deduped (first edge-type wins)", (assert) => {
    const g = parseSilently(
      JSON.stringify({
        nodes: [
          {
            id: "a",
            edges: [
              { nodeId: "b", edgeType: "calls" },
              { nodeId: "b", edgeType: "test" }, // duplicate pair — dropped
            ],
          },
          { id: "b" },
        ],
      }),
    );

    assert.strictEqual(g.edgesFlat.length / 2, 1);

    const callsId = g.edgeTypeNames.indexOf("calls");

    assert.strictEqual(g.edgeTypeIds[0], callsId, "first edge-type assignment kept");
  });

  test("bare-id edges intern to the untyped edge type (index 0)", (assert) => {
    const g = parseSilently(
      JSON.stringify({
        nodes: [{ id: "a", edges: ["b"] }, { id: "b" }],
      }),
    );

    assert.strictEqual(g.edgeTypeNames[0], "", "index 0 is the untyped name");
    assert.strictEqual(g.edgeTypeIds[0], 0, "bare-id edge gets the untyped type id");
  });

  test("interns distinct edge types as 1, 2, … in encounter order", (assert) => {
    const g = parseSilently(
      JSON.stringify({
        nodes: [
          {
            id: "a",
            edges: [
              { nodeId: "b", edgeType: "calls" },
              { nodeId: "c", edgeType: "test" },
            ],
          },
          { id: "b" },
          { id: "c" },
        ],
      }),
    );

    assert.deepEqual(g.edgeTypeNames, ["", "calls", "test"]);
  });

  test("interns distinct node types and assigns nodeTypeIds", (assert) => {
    const g = parseSilently(
      JSON.stringify({
        nodes: [
          { id: "a", type: "file" },
          { id: "b", type: "package" },
          { id: "c", type: "file" },
          { id: "d" }, // untyped
        ],
      }),
    );

    assert.deepEqual(g.nodeTypeNames, ["", "file", "package"]);
    assert.strictEqual(g.nodeTypeIds[0], 1, "file");
    assert.strictEqual(g.nodeTypeIds[1], 2, "package");
    assert.strictEqual(g.nodeTypeIds[2], 1, "file again — same intern");
    assert.strictEqual(g.nodeTypeIds[3], 0, "untyped (default)");
  });

  test("in-degree / out-degree counts match the flat edge list", (assert) => {
    const g = parseSilently(
      JSON.stringify({
        nodes: [
          { id: "a", edges: ["b", "c"] }, // out=2
          { id: "b", edges: ["c"] }, // out=1
          { id: "c" }, // in=2
        ],
      }),
    );

    assert.deepEqual(Array.from(g.outDegree), [2, 1, 0]);
    assert.deepEqual(Array.from(g.inDegree), [0, 1, 2]);
  });

  test("metas pass through unchanged", (assert) => {
    const g = parseSilently(
      JSON.stringify({
        nodes: [
          { id: "a", meta: { size: 42, kind: "module" } },
          { id: "b" }, // no meta
        ],
      }),
    );

    assert.deepEqual(g.metas[0], { size: 42, kind: "module" });
    assert.strictEqual(g.metas[1], undefined);
  });
});
