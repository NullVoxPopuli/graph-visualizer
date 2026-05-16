import { module, test } from "qunit";

import { buildContraction } from "#lib/contract";
import { indexOf, makeGraph } from "#test-helpers/graph";

import type { Contraction } from "#lib/contract";
import type { LoadedGraph } from "#lib/types";

function unitRadii(graph: LoadedGraph): Float32Array {
  return new Float32Array(graph.ids.length).fill(1);
}

/**
 * Force the union `Contraction | null` to non-null with a deferred
 * assertion. Lets each test's body fail with a clear "expected
 * contraction" message rather than crashing on `c.hideMask` access
 * when the function returns null unexpectedly. Avoids the
 * `qunit/no-conditional-assertions` rule that fires on
 * `if (c) assert.…` patterns.
 */
function expectContraction(
  result: Contraction | null,
  assert: Assert,
  message = "expected a Contraction",
): Contraction {
  assert.notStrictEqual(result, null, message);

  return (
    result ?? {
      hideMask: new Uint8Array(),
      nodeRemap: new Int32Array(),
      effectiveRadii: new Float32Array(),
    }
  );
}

module("Unit | lib/contract | buildContraction", () => {
  test("returns null when no filter / collapse / hide is in effect", (assert) => {
    const g = makeGraph({
      nodes: [{ id: "a", edges: ["b"] }, { id: "b" }],
    });

    assert.strictEqual(buildContraction(g, unitRadii(g), new Set(), new Set()), null);
  });

  test("hiding a node type folds its members into a visible owner", (assert) => {
    const g = makeGraph({
      nodes: [
        { id: "pkg", type: "package", edges: ["file1"] },
        { id: "file1", type: "file" },
      ],
    });
    const fileType = g.nodeTypeNames.indexOf("file");
    const c = expectContraction(
      buildContraction(g, unitRadii(g), new Set([fileType]), new Set()),
      assert,
    );
    const pkg = indexOf(g, "pkg");
    const file = indexOf(g, "file1");

    assert.strictEqual(c.hideMask[file], 1, "file is hidden");
    assert.strictEqual(c.hideMask[pkg], 0, "pkg stays visible");
    assert.strictEqual(c.nodeRemap[file], pkg, "file remaps to its owner");
    assert.strictEqual(c.nodeRemap[pkg], pkg, "pkg remaps to itself");
  });

  test("hidden node type without a visible predecessor leaves the node un-owned", (assert) => {
    // file1 has no incoming edge from a visible node — nothing to fold it into.
    const g = makeGraph({
      nodes: [
        { id: "file1", type: "file" },
        { id: "pkg", type: "package" },
      ],
    });
    const fileType = g.nodeTypeNames.indexOf("file");
    const c = expectContraction(
      buildContraction(g, unitRadii(g), new Set([fileType]), new Set()),
      assert,
    );

    assert.strictEqual(c.nodeRemap[indexOf(g, "file1")], -1, "no owner found → -1");
  });

  test("explicit hiddenNodeIds always maps to -1 (drop, don't fold)", (assert) => {
    const g = makeGraph({
      nodes: [{ id: "a", edges: ["b"] }, { id: "b" }],
    });
    const c = expectContraction(
      buildContraction(g, unitRadii(g), new Set(), new Set(), new Set(["a"])),
      assert,
    );
    const a = indexOf(g, "a");

    assert.strictEqual(c.hideMask[a], 1, "explicitly-hidden node hidden");
    assert.strictEqual(c.nodeRemap[a], -1, "no owner — id-hides drop entirely");
  });

  test("collapsedIds flips the type-hide baseline for direct children", (assert) => {
    // With `file` hidden by type and `pkg` toggled (collapsed), pkg's
    // child files have their baseline INVERTED — so file1 becomes
    // visible even though `file` is hidden.
    const g = makeGraph({
      nodes: [
        { id: "pkg", type: "package", edges: ["file1"] },
        { id: "file1", type: "file" },
      ],
    });
    const fileType = g.nodeTypeNames.indexOf("file");
    const c = expectContraction(
      buildContraction(g, unitRadii(g), new Set([fileType]), new Set(["pkg"])),
      assert,
    );

    assert.strictEqual(c.hideMask[indexOf(g, "file1")], 0, "inverted-baseline file is now visible");
  });

  test("absorbed radii grow the owner: total area is preserved", (assert) => {
    const g = makeGraph({
      nodes: [
        { id: "pkg", type: "package", edges: ["file1", "file2"] },
        { id: "file1", type: "file" },
        { id: "file2", type: "file" },
      ],
    });
    const radii = unitRadii(g);
    const fileType = g.nodeTypeNames.indexOf("file");
    const c = expectContraction(buildContraction(g, radii, new Set([fileType]), new Set()), assert);
    const pkg = indexOf(g, "pkg");
    // Owner absorbed two unit-area files → its effective radius² is 1 + 2 = 3.
    const eff = c.effectiveRadii[pkg]!;

    assert.true(
      Math.abs(eff * eff - 3) < 1e-5,
      `expected radius² ≈ 3 after absorbing 2 unit-area files, got ${eff * eff}`,
    );
    assert.strictEqual(c.effectiveRadii[indexOf(g, "file1")], 0);
    assert.strictEqual(c.effectiveRadii[indexOf(g, "file2")], 0);
  });
});
