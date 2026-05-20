import { module, test } from "qunit";

import { buildContraction } from "#lib/contract";
import { bundleAlreadyContractedCycles, bundleRawCyclesWithGroups } from "#lib/cycle";
import { indexOf, makeGraph } from "#test-helpers/graph";

import type { LoadedGraph } from "#lib/types";

function unitRadii(graph: LoadedGraph): Float32Array {
  return new Float32Array(graph.ids.length).fill(1);
}

module("Unit | lib/cycle | bundling through a hidden node type", () => {
  test("a file-level cycle that bridges two packages surfaces as a package-level cycle when files are hidden", (assert) => {
    // a (package) -> b, c (files) and d (package) -> e, f (files).
    // The file-level cycle b -> c -> e -> b bridges both packages because
    // b/c are owned by `a` and e is owned by `d`. When the user hides
    // the `file` type, the cycle should appear as a 2-step bundle
    // between the two packages — this regressed before and was visible
    // on the do-not-commit.json fixture under the "uncheck file" flow.
    const g = makeGraph({
      nodes: [
        { id: "a", type: "package", edges: ["b", "c"] },
        { id: "d", type: "package", edges: ["e", "f"] },
        { id: "b", type: "file", edges: ["c"] },
        { id: "c", type: "file", edges: ["e"] },
        { id: "e", type: "file", edges: ["b"] },
        { id: "f", type: "file" },
      ],
    });

    const fileType = g.nodeTypeNames.indexOf("file");
    const contraction = buildContraction(g, unitRadii(g), new Set([fileType]), new Set());

    assert.notStrictEqual(contraction, null, "contraction should be active when a type is hidden");

    const remap = contraction?.nodeRemap ?? null;
    const a = indexOf(g, "a");
    const d = indexOf(g, "d");
    // Construct the raw file-level cycle the Rust enumerator would
    // return for this graph: b -> c -> e -> b. Asserting against this
    // exact list keeps the JS bundling pass under test even when the
    // Rust harness isn't available (unit tests don't load WASM).
    const rawCycle = [indexOf(g, "b"), indexOf(g, "c"), indexOf(g, "e")];
    const bundled = bundleRawCyclesWithGroups([rawCycle], remap);

    assert.strictEqual(bundled.length, 1, "exactly one bundled cycle survives the contraction");

    const cycle = bundled[0]!;
    const ids = cycle.bundled.toSorted((x, y) => x - y);

    assert.deepEqual(
      ids,
      [a, d].toSorted((x, y) => x - y),
      "cycle bridges packages a and d",
    );
  });
});

module("Unit | lib/cycle | bundleAlreadyContractedCycles", () => {
  test("dedupes already-contracted cycles by visual key", (assert) => {
    // pkgA <-> pkgB with two distinct file paths in each direction.
    // Rust running on the contracted CSR returns one cycle per file-path
    // combination — without dedupe the panel would show four [pkgA, pkgB]
    // rows that all look identical to the user. The visual-key dedupe in
    // `bundleAlreadyContractedCycles` collapses them to one.
    const g = makeGraph({
      nodes: [
        { id: "pkgA", type: "package", edges: ["a1", "a2"] },
        { id: "pkgB", type: "package", edges: ["b1", "b2"] },
        { id: "a1", type: "file", edges: ["pkgB"] },
        { id: "a2", type: "file", edges: ["pkgB"] },
        { id: "b1", type: "file", edges: ["pkgA"] },
        { id: "b2", type: "file", edges: ["pkgA"] },
      ],
    });
    const fileType = g.nodeTypeNames.indexOf("file");
    const contraction = buildContraction(g, unitRadii(g), new Set([fileType]), new Set());
    const remap = contraction!.nodeRemap;
    const pkgA = indexOf(g, "pkgA");
    const pkgB = indexOf(g, "pkgB");

    // Simulate Rust's edge-deduped enumeration: a single [pkgA, pkgB] cycle.
    // The point of the test is that *multiple* such cycles (e.g. from a
    // future regression that re-emits parallel-edge dupes) would still
    // collapse to one row here.
    const result = bundleAlreadyContractedCycles(g, remap, [
      [pkgA, pkgB],
      [pkgA, pkgB],
      [pkgA, pkgB],
    ]);

    assert.strictEqual(result.length, 1, "three identical bundled cycles collapse to one entry");
    assert.deepEqual(result[0]!.bundled, [pkgA, pkgB], "the surviving cycle is the package pair");
  });

  test("reconstructs raw-file chains under each step of a contracted cycle", (assert) => {
    // Same shape as the previous test but only one file per direction so
    // the BFS chain reconstruction is fully determined.
    const g = makeGraph({
      nodes: [
        { id: "pkgA", type: "package", edges: ["a1"] },
        { id: "pkgB", type: "package", edges: ["b1"] },
        { id: "a1", type: "file", edges: ["pkgB"] },
        { id: "b1", type: "file", edges: ["pkgA"] },
      ],
    });
    const fileType = g.nodeTypeNames.indexOf("file");
    const remap = buildContraction(g, unitRadii(g), new Set([fileType]), new Set())!.nodeRemap;
    const pkgA = indexOf(g, "pkgA");
    const pkgB = indexOf(g, "pkgB");
    const a1 = indexOf(g, "a1");
    const b1 = indexOf(g, "b1");

    const result = bundleAlreadyContractedCycles(g, remap, [[pkgA, pkgB]]);

    assert.strictEqual(result.length, 1);
    assert.deepEqual(result[0]!.bundled, [pkgA, pkgB]);
    assert.deepEqual(
      result[0]!.groups,
      [
        [pkgA, a1],
        [pkgB, b1],
      ],
      "each step's group includes the visible rep followed by the file chain reaching the next rep",
    );
  });
});
