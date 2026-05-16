import { module, test } from "qunit";

import {
  bundleRawCycles,
  bundleRawCyclesWithGroups,
  canonicalCycleKey,
  contractCycle,
  contractCycleWithGroups,
  findAllCycles,
  findBundledCyclesViaRaw,
  findBundledCyclesWithGroups,
  findShortestCycleThrough,
  hasAnyCycle,
  shortCycleId,
} from "#lib/cycle";
import { cycleToIds, indexOf, makeGraph } from "#test-helpers/graph";

module("Unit | lib/cycle | canonicalCycleKey", () => {
  test("is rotationally invariant", (assert) => {
    assert.strictEqual(canonicalCycleKey([1, 2, 3]), "1,2,3");
    assert.strictEqual(canonicalCycleKey([2, 3, 1]), "1,2,3");
    assert.strictEqual(canonicalCycleKey([3, 1, 2]), "1,2,3");
  });

  test("preserves direction (reversed != original)", (assert) => {
    assert.notStrictEqual(canonicalCycleKey([1, 2, 3]), canonicalCycleKey([1, 3, 2]));
  });

  test("two cycles that share min-vertex but differ elsewhere produce different keys", (assert) => {
    assert.notStrictEqual(canonicalCycleKey([0, 1, 2]), canonicalCycleKey([0, 2, 1]));
  });
});

module("Unit | lib/cycle | shortCycleId", () => {
  test("returns 8 lowercase hex chars", (assert) => {
    const id = shortCycleId("anything", new Set());

    assert.true(/^[0-9a-f]{8}$/.test(id), `expected 8 hex chars, got ${id}`);
  });

  test("is deterministic for the same canonical key", (assert) => {
    const a = shortCycleId("foo,bar", new Set());
    const b = shortCycleId("foo,bar", new Set());

    assert.strictEqual(a, b);
  });

  test("different keys produce different ids (practically)", (assert) => {
    assert.notStrictEqual(shortCycleId("foo", new Set()), shortCycleId("bar", new Set()));
  });

  test("avoids collisions by re-hashing with attempt suffix", (assert) => {
    const baseId = shortCycleId("seed", new Set());
    const used = new Set([baseId]);
    const next = shortCycleId("seed", used);

    assert.notStrictEqual(next, baseId);
    assert.true(used.has(next));
  });

  test("mutates the passed `used` set", (assert) => {
    const used = new Set<string>();

    shortCycleId("x", used);
    assert.strictEqual(used.size, 1);
  });
});

module("Unit | lib/cycle | contractCycle", () => {
  test("null remap returns a copy of the raw cycle", (assert) => {
    const raw = [1, 2, 3];
    const out = contractCycle(raw, null);

    assert.deepEqual(out, [1, 2, 3]);
    assert.notStrictEqual(out, raw, "returned array is a fresh copy");
  });

  test("collapses consecutive same-rep nodes", (assert) => {
    // 0,1 → pkg10; 2,3 → pkg20; 4 → pkg30
    const remap = new Int32Array([10, 10, 20, 20, 30]);

    assert.deepEqual(contractCycle([0, 1, 2, 3, 4], remap), [10, 20, 30]);
  });

  test("trims wrap-around duplicates", (assert) => {
    // raw walks: 0→2→1→0 (cycle close). 0,1 share rep 10; 2 has rep 20.
    // After collapse: [10, 20, 10]. Wraparound trim → [10, 20].
    const remap = new Int32Array([10, 10, 20]);

    assert.deepEqual(contractCycle([0, 2, 1], remap), [10, 20]);
  });

  test("returns null when a raw node remaps to -1 (orphaned)", (assert) => {
    const remap = new Int32Array([10, -1, 20]);

    assert.strictEqual(contractCycle([0, 1, 2], remap), null);
  });

  test("returns null when the contracted cycle degenerates to ≤1 node", (assert) => {
    // Everything maps to the same rep.
    const remap = new Int32Array([5, 5, 5]);

    assert.strictEqual(contractCycle([0, 1, 2], remap), null);
  });
});

module("Unit | lib/cycle | contractCycleWithGroups", () => {
  test("null remap puts each raw idx in its own group", (assert) => {
    const result = contractCycleWithGroups([7, 8, 9], null);

    assert.deepEqual(result?.bundled, [7, 8, 9]);
    assert.deepEqual(result?.groups, [[7], [8], [9]]);
  });

  test("consecutive same-rep nodes aggregate into one group", (assert) => {
    const remap = new Int32Array([10, 10, 20]);
    const result = contractCycleWithGroups([0, 1, 2], remap);

    assert.deepEqual(result?.bundled, [10, 20]);
    assert.deepEqual(result?.groups, [[0, 1], [2]]);
  });

  test("wrap-around tail folds into the head group", (assert) => {
    // raw [0, 2, 1] with 0,1 → 10 and 2 → 20.
    // After iteration: bundled=[10,20,10], groups=[[0],[2],[1]].
    // Wraparound trim: pop tail; prepend tail's raw indices to head group.
    const remap = new Int32Array([10, 10, 20]);
    const result = contractCycleWithGroups([0, 2, 1], remap);

    assert.deepEqual(result?.bundled, [10, 20]);
    assert.deepEqual(result?.groups, [[1, 0], [2]]);
  });

  test("returns null when a raw node remaps to -1", (assert) => {
    const remap = new Int32Array([10, -1, 20]);

    assert.strictEqual(contractCycleWithGroups([0, 1, 2], remap), null);
  });

  test("returns null on degenerate contraction (everything one rep)", (assert) => {
    const remap = new Int32Array([5, 5, 5]);

    assert.strictEqual(contractCycleWithGroups([0, 1, 2], remap), null);
  });
});

module("Unit | lib/cycle | hasAnyCycle", () => {
  test("empty graph has no cycles", (assert) => {
    assert.false(hasAnyCycle(makeGraph({ nodes: [] })));
  });

  test("DAG has no cycles", (assert) => {
    const g = makeGraph({
      nodes: [{ id: "a", edges: ["b", "c"] }, { id: "b", edges: ["c"] }, { id: "c" }],
    });

    assert.false(hasAnyCycle(g));
  });

  test("simple 2-cycle detected", (assert) => {
    const g = makeGraph({
      nodes: [
        { id: "a", edges: ["b"] },
        { id: "b", edges: ["a"] },
      ],
    });

    assert.true(hasAnyCycle(g));
  });

  test("3-cycle detected", (assert) => {
    const g = makeGraph({
      nodes: [
        { id: "a", edges: ["b"] },
        { id: "b", edges: ["c"] },
        { id: "c", edges: ["a"] },
      ],
    });

    assert.true(hasAnyCycle(g));
  });

  test("disconnected DAG + cycle: still reports cycle", (assert) => {
    const g = makeGraph({
      nodes: [
        { id: "a", edges: ["b"] },
        { id: "b" },
        { id: "c", edges: ["d"] },
        { id: "d", edges: ["c"] },
      ],
    });

    assert.true(hasAnyCycle(g));
  });

  test("hidden edge types can break the only cycle", (assert) => {
    const g = makeGraph({
      nodes: [
        { id: "a", edges: [{ nodeId: "b", edgeType: "test" }] },
        { id: "b", edges: ["a"] },
      ],
    });
    const testType = g.edgeTypeNames.indexOf("test");

    assert.true(hasAnyCycle(g), "cycle present with no filter");
    assert.false(hasAnyCycle(g, new Set([testType])), "filter drops the only cycle edge");
  });
});

module("Unit | lib/cycle | findAllCycles", () => {
  test("empty graph returns no cycles", (assert) => {
    assert.deepEqual(findAllCycles(makeGraph({ nodes: [] })), []);
  });

  test("DAG returns no cycles", (assert) => {
    const g = makeGraph({
      nodes: [{ id: "a", edges: ["b"] }, { id: "b", edges: ["c"] }, { id: "c" }],
    });

    assert.deepEqual(findAllCycles(g), []);
  });

  test("single 3-cycle is enumerated once", (assert) => {
    const g = makeGraph({
      nodes: [
        { id: "a", edges: ["b"] },
        { id: "b", edges: ["c"] },
        { id: "c", edges: ["a"] },
      ],
    });
    const cycles = findAllCycles(g);

    assert.strictEqual(cycles.length, 1);
    assert.strictEqual(cycles[0]!.length, 3);
    assert.deepEqual(cycleToIds(g, cycles[0]!).sort(), ["a", "b", "c"]);
  });

  test("two independent cycles produce two entries", (assert) => {
    const g = makeGraph({
      nodes: [
        { id: "a", edges: ["b"] },
        { id: "b", edges: ["a"] },
        { id: "c", edges: ["d"] },
        { id: "d", edges: ["c"] },
      ],
    });

    assert.strictEqual(findAllCycles(g).length, 2);
  });

  test("output is sorted shortest-first", (assert) => {
    const g = makeGraph({
      nodes: [
        { id: "a", edges: ["b", "c"] },
        { id: "b", edges: ["a"] },
        { id: "c", edges: ["d"] },
        { id: "d", edges: ["e"] },
        { id: "e", edges: ["a"] },
      ],
    });
    const lengths = findAllCycles(g).map((c) => c.length);

    for (let i = 1; i < lengths.length; i++) {
      assert.true(
        lengths[i - 1]! <= lengths[i]!,
        `cycles[${i - 1}] (len ${lengths[i - 1]}) should be ≤ cycles[${i}] (len ${lengths[i]})`,
      );
    }
  });

  test("maxCycles caps the output", (assert) => {
    const g = makeGraph({
      nodes: [
        { id: "a", edges: ["b"] },
        { id: "b", edges: ["a"] },
        { id: "c", edges: ["d"] },
        { id: "d", edges: ["c"] },
      ],
    });

    assert.strictEqual(findAllCycles(g, null, 1).length, 1);
    assert.strictEqual(findAllCycles(g, null, 1000).length, 2);
  });

  test("hiddenEdgeTypes filters out matching edges", (assert) => {
    const g = makeGraph({
      nodes: [
        { id: "a", edges: [{ nodeId: "b", edgeType: "test" }] },
        { id: "b", edges: ["a"] },
      ],
    });
    const testType = g.edgeTypeNames.indexOf("test");

    assert.strictEqual(findAllCycles(g).length, 1);
    assert.strictEqual(findAllCycles(g, null, 1000, new Set([testType])).length, 0);
  });

  test("self-loops are skipped (parser drops them) so no length-1 cycles surface", (assert) => {
    const g = makeGraph({
      nodes: [
        { id: "a", edges: ["a", "b"] },
        { id: "b", edges: ["a"] },
      ],
    });
    const cycles = findAllCycles(g);

    assert.strictEqual(cycles.length, 1);
    assert.true(cycles[0]!.length >= 2, "no length-1 (self-loop) cycles emitted");
  });
});

module("Unit | lib/cycle | findShortestCycleThrough", () => {
  test("returns null when no graph nodes", (assert) => {
    const g = makeGraph({ nodes: [] });

    assert.strictEqual(findShortestCycleThrough(g, 0), null);
  });

  test("returns null when source is out of bounds", (assert) => {
    const g = makeGraph({ nodes: [{ id: "a" }] });

    assert.strictEqual(findShortestCycleThrough(g, -1), null);
    assert.strictEqual(findShortestCycleThrough(g, 5), null);
  });

  test("returns null when the source isn't on any cycle", (assert) => {
    const g = makeGraph({
      nodes: [{ id: "a", edges: ["b"] }, { id: "b" }],
    });

    assert.strictEqual(findShortestCycleThrough(g, indexOf(g, "a")), null);
  });

  test("returns the cycle's nodes in order starting at source", (assert) => {
    const g = makeGraph({
      nodes: [
        { id: "a", edges: ["b"] },
        { id: "b", edges: ["c"] },
        { id: "c", edges: ["a"] },
      ],
    });
    const cycle = findShortestCycleThrough(g, indexOf(g, "a")) ?? [];

    assert.deepEqual(cycleToIds(g, cycle), ["a", "b", "c"]);
    assert.strictEqual(cycle[0], indexOf(g, "a"), "starts at source");
  });

  test("prefers the shortest cycle when several exist through the source", (assert) => {
    const g = makeGraph({
      nodes: [
        { id: "a", edges: ["b", "c"] },
        { id: "b", edges: ["a"] }, // short 2-cycle
        { id: "c", edges: ["d"] },
        { id: "d", edges: ["a"] }, // longer 3-cycle
      ],
    });
    const cycle = findShortestCycleThrough(g, indexOf(g, "a"));

    assert.deepEqual(cycle, [indexOf(g, "a"), indexOf(g, "b")]);
  });
});

module("Unit | lib/cycle | bundleRawCycles", () => {
  test("null remap returns raw cycles deduped + shortest-first", (assert) => {
    // Two distinct cycles, second shorter.
    const cycles = [
      [0, 1, 2],
      [3, 4],
    ];
    const out = bundleRawCycles(cycles, null);

    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0]!.length, 2);
    assert.strictEqual(out[1]!.length, 3);
  });

  test("dedupes bundled cycles that share a visual key", (assert) => {
    // Same shape under contraction (both produce [10, 20]) → one entry kept.
    const remap = new Int32Array([10, 10, 20, 20]);
    const out = bundleRawCycles(
      [
        [0, 2],
        [1, 3],
      ],
      remap,
    );

    assert.strictEqual(out.length, 1);
    assert.deepEqual(out[0], [10, 20]);
  });

  test("drops cycles that contract to nothing", (assert) => {
    // Everything maps to the same rep → degenerate; drop.
    const remap = new Int32Array([5, 5, 5]);

    assert.deepEqual(bundleRawCycles([[0, 1, 2]], remap), []);
  });
});

module("Unit | lib/cycle | bundleRawCyclesWithGroups", () => {
  test("carries per-step raw groups through", (assert) => {
    const remap = new Int32Array([10, 10, 20]);
    const out = bundleRawCyclesWithGroups([[0, 1, 2]], remap);

    assert.strictEqual(out.length, 1);
    assert.deepEqual(out[0]?.bundled, [10, 20]);
    assert.deepEqual(out[0]?.groups, [[0, 1], [2]]);
  });

  test("null remap puts every raw idx in its own singleton group", (assert) => {
    const out = bundleRawCyclesWithGroups([[0, 1, 2]], null);

    assert.deepEqual(out[0]?.bundled, [0, 1, 2]);
    assert.deepEqual(out[0]?.groups, [[0], [1], [2]]);
  });

  test("sorted shortest-first by bundled length", (assert) => {
    const out = bundleRawCyclesWithGroups(
      [
        [0, 1, 2],
        [3, 4],
      ],
      null,
    );

    assert.strictEqual(out[0]?.bundled.length, 2);
    assert.strictEqual(out[1]?.bundled.length, 3);
  });
});

module("Unit | lib/cycle | findBundledCyclesViaRaw / findBundledCyclesWithGroups", () => {
  test("returns the same bundled shapes as the raw enumeration when remap is null", (assert) => {
    const g = makeGraph({
      nodes: [
        { id: "a", edges: ["b"] },
        { id: "b", edges: ["c"] },
        { id: "c", edges: ["a"] },
      ],
    });
    const direct = findAllCycles(g);
    const viaRaw = findBundledCyclesViaRaw(g, null);

    assert.strictEqual(viaRaw.length, direct.length);
    assert.deepEqual(viaRaw[0], direct[0]);
  });

  test("WithGroups variant matches the same bundled shapes", (assert) => {
    const g = makeGraph({
      nodes: [
        { id: "a", edges: ["b"] },
        { id: "b", edges: ["a"] },
      ],
    });
    const viaRaw = findBundledCyclesViaRaw(g, null);
    const withGroups = findBundledCyclesWithGroups(g, null);

    assert.strictEqual(withGroups.length, viaRaw.length);
    assert.deepEqual(withGroups[0]?.bundled, viaRaw[0]);
    assert.deepEqual(
      withGroups[0]?.groups,
      viaRaw[0]!.map((idx) => [idx]),
    );
  });
});
