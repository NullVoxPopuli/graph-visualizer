/**
 * JS ↔ Rust parity harness.
 *
 * Some graph algorithms still exist in TypeScript (`#lib/parser`,
 * `#lib/cycle`, `#lib/pack`) alongside the Rust/WASM port the app runs
 * (`crates/layout-wasm`, surfaced as `GraphSession`). Nothing automated
 * guarded that they stay equivalent — a refactor on either side could
 * silently diverge. This runs both over every shipped example and
 * asserts they agree, plus fixed-fixture specs for the algorithms whose
 * JS copy has been removed.
 *
 * Run:  pnpm test:parity        (requires `pnpm build:wasm` first)
 *
 * Coverage today (everything the WASM surface exposes):
 *   - parse:   node count, ids, flat edge list, degrees   — exact
 *   - radii:   vs `computeRadii`                           — exact (±1e-4)
 *   - orphans: `find_orphans` / `has_any_orphan` against
 *     concrete fixtures (edge-type filter + declared roots) — the JS
 *     `orphans.ts` was removed when orphans moved into the session
 *   - cycles: `raw_cycles` / `has_any_cycle` against concrete
 *     fixtures (incl. an edge-type filter) — `cycle.ts`'s enumeration
 *     was removed when cycles moved into the session, so these are
 *     expected-value specs, not a cross-check
 *   - Louvain: determinism (exact, across two loads) + a sane
 *     community count + reported modularity. No JS Louvain left to
 *     cross-check (graphology removed); determinism is the invariant.
 *
 * Node runs this `.ts` directly via `tsx` (see package.json). The
 * `--target nodejs` WASM build initializes synchronously on `require`.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { EXAMPLES } from "#lib/examples";
import { computeRadii } from "#lib/pack";
import { parseGraphJson } from "#lib/parser";

const EMPTY = new Int32Array(0);

interface RustSession {
  node_count(): number;
  ids_json(): string;
  edges_flat(): Int32Array;
  communities(): Int32Array;
  radii(): Float32Array;
  has_any_cycle(hiddenEdgeTypeIds: Int32Array): boolean;
  raw_cycles(hiddenEdgeTypeIds: Int32Array, nodeRemap: Int32Array): Int32Array;
  has_any_orphan(hiddenEdgeTypeIds: Int32Array): boolean;
  find_orphans(hiddenEdgeTypeIds: Int32Array, rootIndices: Int32Array): Int32Array;
  free(): void;
}
interface RustModule {
  GraphSession: { load(json: string): RustSession };
}

const require = createRequire(import.meta.url);

function rustModule(): RustModule {
  const spec = fileURLToPath(
    new URL("../crates/layout-wasm/pkg-node/layout_wasm.js", import.meta.url),
  );

  let mod: RustModule & { default?: RustModule };

  try {
    mod = require(spec) as typeof mod;
  } catch {
    throw new Error("[parity] WASM backend not built. Run `pnpm build:wasm` first.");
  }

  const m = typeof mod.GraphSession === "function" ? mod : (mod.default as RustModule);

  if (!m?.GraphSession) throw new Error("[parity] pkg-node missing the GraphSession export.");

  return m;
}

/**
 * Undirected modularity of a partition. Standard fast form:
 * Q = Σ_c [ L_c/m − (D_c/2m)² ], where L_c = intra-community edges and
 * D_c = total degree in community c. Direction and duplicate (a,b)/(b,a)
 * pairs are collapsed and self-loops dropped, matching how Louvain treats
 * the graph here.
 */
function modularity(n: number, edgesFlat: Int32Array, comm: Int32Array): number {
  const undirected = new Set<number>();

  for (let i = 0; i < edgesFlat.length; i += 2) {
    let a = edgesFlat[i]!;
    let b = edgesFlat[i + 1]!;

    if (a === b) continue;
    if (a > b) [a, b] = [b, a];

    undirected.add(a * n + b);
  }

  const m = undirected.size;

  if (m === 0) return 0;

  const deg = new Float64Array(n);
  const intra = new Map<number, number>();
  const dsum = new Map<number, number>();

  for (const key of undirected) {
    const a = Math.floor(key / n);
    const b = key % n;

    deg[a]! += 1;
    deg[b]! += 1;

    if (comm[a] === comm[b]) {
      intra.set(comm[a]!, (intra.get(comm[a]!) ?? 0) + 1);
    }
  }

  for (let i = 0; i < n; i++) {
    dsum.set(comm[i]!, (dsum.get(comm[i]!) ?? 0) + deg[i]!);
  }

  let q = 0;

  for (const [c, dc] of dsum) {
    q += (intra.get(c) ?? 0) / m - (dc / (2 * m)) ** 2;
  }

  return q;
}

function intArrayEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;

  return true;
}

function distinctCount(a: Int32Array): number {
  return new Set(Array.from(a)).size;
}

function examplePath(url: string): string {
  return fileURLToPath(new URL(`../public${url}`, import.meta.url));
}

interface OrphanFixture {
  name: string;
  json: string;
  /** edge-type ids to hide. The parser interns types first-seen with
   *  0 = "" (untyped), so a graph whose only typed edge is "test" has
   *  "test" === 1; an all-untyped graph hides 0. */
  hidden?: number[];
  /** node indices the user declared as roots (never peeled). */
  roots?: number[];
  expectOrphans: string[];
  expectHasAny: boolean;
}

/**
 * Fixed-fixture specs for orphan detection, ported from the deleted
 * `tests/unit/orphans-test.ts` — they now drive the *live* Rust
 * `GraphSession` (the JS `orphans.ts` they used to test is gone). Exact
 * expected values, so they guard behavior without a JS cross-check.
 */
function checkOrphanFixtures(GraphSession: RustModule["GraphSession"]): string[] {
  const fails: string[] = [];
  const fixtures: OrphanFixture[] = [
    { name: "empty graph", json: `{"nodes":[]}`, expectOrphans: [], expectHasAny: false },
    {
      name: "linear DAG peels entirely",
      json: `{"nodes":[{"id":"src","edges":["mid"]},{"id":"mid","edges":["sink"]},{"id":"sink"}]}`,
      expectOrphans: ["mid", "sink", "src"],
      expectHasAny: true,
    },
    {
      name: "pure cycle has no orphans",
      json: `{"nodes":[{"id":"a","edges":["b"]},{"id":"b","edges":["a"]}]}`,
      expectOrphans: [],
      expectHasAny: false,
    },
    {
      name: "node feeding a cycle is an orphan",
      json: `{"nodes":[{"id":"src","edges":["a"]},{"id":"a","edges":["b"]},{"id":"b","edges":["a"]}]}`,
      expectOrphans: ["src"],
      expectHasAny: true,
    },
    {
      name: "hiding the edge type that closes a cycle exposes both nodes",
      json: `{"nodes":[{"id":"a","edges":[{"nodeId":"b","edgeType":"test"}]},{"id":"b","edges":[{"nodeId":"a","edgeType":"test"}]}]}`,
      hidden: [1],
      expectOrphans: ["a", "b"],
      expectHasAny: true,
    },
    {
      name: "transitive peel (a→b, c→b ⇒ all)",
      json: `{"nodes":[{"id":"a","edges":["b"]},{"id":"b"},{"id":"c","edges":["b"]}]}`,
      expectOrphans: ["a", "b", "c"],
      expectHasAny: true,
    },
    {
      name: "isolated node is an orphan even beside a cycle",
      json: `{"nodes":[{"id":"alone"},{"id":"a","edges":["b"]},{"id":"b","edges":["a"]}]}`,
      expectOrphans: ["alone"],
      expectHasAny: true,
    },
    {
      name: "declared root is never peeled (blocks the whole chain)",
      json: `{"nodes":[{"id":"src","edges":["mid"]},{"id":"mid","edges":["sink"]},{"id":"sink"}]}`,
      roots: [0],
      expectOrphans: [],
      expectHasAny: true,
    },
  ];

  for (const fx of fixtures) {
    const s = GraphSession.load(fx.json);

    try {
      const ids = JSON.parse(s.ids_json()) as string[];
      const hidden = Int32Array.from(fx.hidden ?? []);
      const roots = Int32Array.from(fx.roots ?? []);
      const got = Array.from(s.find_orphans(hidden, roots))
        .map((i) => ids[i]!)
        .sort();
      const want = [...fx.expectOrphans].sort();

      if (JSON.stringify(got) !== JSON.stringify(want)) {
        fails.push(`orphan fixture "${fx.name}": got [${got.join(",")}] want [${want.join(",")}]`);
      }

      if (s.has_any_orphan(hidden) !== fx.expectHasAny) {
        fails.push(`orphan fixture "${fx.name}": has_any_orphan ≠ ${fx.expectHasAny}`);
      }
    } finally {
      s.free();
    }
  }

  return fails;
}

interface CycleFixture {
  name: string;
  json: string;
  hidden?: number[];
  /** Each expected cycle as ids; order/rotation-independent. */
  expectCycles: string[][];
  expectHasAny: boolean;
}

/** Rotation-independent canonical form of a cycle given as id labels:
 *  rotate so the lexicographically-smallest id leads. */
function canonIds(labels: string[]): string {
  if (labels.length === 0) return "";

  let min = 0;

  for (let i = 1; i < labels.length; i++) if (labels[i]! < labels[min]!) min = i;

  return labels.map((_, i) => labels[(min + i) % labels.length]!).join(">");
}

function decodeCycles(flat: Int32Array): number[][] {
  const out: number[][] = [];

  for (let i = 0; i < flat.length; ) {
    const len = flat[i++]!;

    out.push(Array.from(flat.subarray(i, i + len)));
    i += len;
  }

  return out;
}

/**
 * Fixed-fixture specs for cycle enumeration, ported from the deleted
 * `tests/unit/cycle-test.ts` — they drive the live Rust `GraphSession`
 * (`cycle.ts`'s enumeration is gone). Exact expected values.
 */
function checkCycleFixtures(GraphSession: RustModule["GraphSession"]): string[] {
  const fails: string[] = [];
  const fixtures: CycleFixture[] = [
    {
      name: "acyclic DAG",
      json: `{"nodes":[{"id":"a","edges":["b"]},{"id":"b","edges":["c"]},{"id":"c"}]}`,
      expectCycles: [],
      expectHasAny: false,
    },
    {
      name: "self-loop is not a cycle",
      json: `{"nodes":[{"id":"a","edges":["a"]}]}`,
      expectCycles: [],
      expectHasAny: false,
    },
    {
      name: "two-node cycle",
      json: `{"nodes":[{"id":"a","edges":["b"]},{"id":"b","edges":["a"]}]}`,
      expectCycles: [["a", "b"]],
      expectHasAny: true,
    },
    {
      name: "triangle",
      json: `{"nodes":[{"id":"a","edges":["b"]},{"id":"b","edges":["c"]},{"id":"c","edges":["a"]}]}`,
      expectCycles: [["a", "b", "c"]],
      expectHasAny: true,
    },
    {
      name: "two disjoint cycles + acyclic bridge",
      json: `{"nodes":[{"id":"a","edges":["b"]},{"id":"b","edges":["a","c"]},{"id":"c","edges":["d"]},{"id":"d","edges":["c"]}]}`,
      expectCycles: [
        ["a", "b"],
        ["c", "d"],
      ],
      expectHasAny: true,
    },
    {
      name: "hiding the closing edge type breaks the cycle",
      json: `{"nodes":[{"id":"a","edges":[{"nodeId":"b","edgeType":"x"}]},{"id":"b","edges":[{"nodeId":"a","edgeType":"x"}]}]}`,
      hidden: [1],
      expectCycles: [],
      expectHasAny: false,
    },
  ];

  for (const fx of fixtures) {
    const s = GraphSession.load(fx.json);

    try {
      const ids = JSON.parse(s.ids_json()) as string[];
      const hidden = Int32Array.from(fx.hidden ?? []);
      const got = decodeCycles(s.raw_cycles(hidden, EMPTY))
        .map((c) => canonIds(c.map((i) => ids[i]!)))
        .sort();
      const want = fx.expectCycles.map((c) => canonIds(c)).sort();

      if (JSON.stringify(got) !== JSON.stringify(want)) {
        fails.push(
          `cycle fixture "${fx.name}": got [${got.join(" ; ")}] want [${want.join(" ; ")}]`,
        );
      }

      if (s.has_any_cycle(hidden) !== fx.expectHasAny) {
        fails.push(`cycle fixture "${fx.name}": has_any_cycle ≠ ${fx.expectHasAny}`);
      }
    } finally {
      s.free();
    }
  }

  return fails;
}

function main(): void {
  const { GraphSession } = rustModule();
  const failures: string[] = [
    ...checkOrphanFixtures(GraphSession),
    ...checkCycleFixtures(GraphSession),
  ];

  console.info(`  ${failures.length === 0 ? "ok  " : "FAIL"} orphan + cycle fixtures\n`);

  for (const ex of EXAMPLES) {
    const text = readFileSync(examplePath(ex.url), "utf8");
    const js = parseGraphJson(text);
    const rust = GraphSession.load(text);
    const rust2 = GraphSession.load(text);

    try {
      const n = js.ids.length;
      const fail = (msg: string): void => {
        failures.push(`${ex.label}: ${msg}`);
      };

      // --- parse ---
      if (rust.node_count() !== n) fail(`node_count ${rust.node_count()} ≠ ${n}`);

      if (JSON.stringify(JSON.parse(rust.ids_json())) !== JSON.stringify(js.ids)) {
        fail("ids differ");
      }

      if (!intArrayEqual(rust.edges_flat(), js.edgesFlat)) fail("edges_flat differ");

      // --- radii ---
      const jsRadii = computeRadii(js.inDegree, js.outDegree);
      const rustRadii = rust.radii();
      let radiiOk = rustRadii.length === jsRadii.length;

      for (let i = 0; radiiOk && i < jsRadii.length; i++) {
        if (Math.abs(rustRadii[i]! - jsRadii[i]!) > 1e-4) radiiOk = false;
      }

      if (!radiiOk) fail("radii differ (>1e-4)");

      // --- orphans (no JS copy to compare to; consistency smoke +
      // fixed-fixture specs run separately in checkOrphanFixtures) ---
      const rustOrph = Array.from(rust.find_orphans(EMPTY, EMPTY));

      if (rustOrph.length > 0 !== rust.has_any_orphan(EMPTY)) {
        fail("find_orphans / has_any_orphan disagree");
      }

      // --- cycles (no JS copy; consistency smoke + checkCycleFixtures) ---
      if (rust.raw_cycles(EMPTY, EMPTY).length > 0 !== rust.has_any_cycle(EMPTY)) {
        fail("raw_cycles / has_any_cycle disagree");
      }

      // --- Louvain: determinism + quality ---
      const comm = rust.communities();

      if (!intArrayEqual(comm, rust2.communities())) fail("Louvain not deterministic");

      const k = distinctCount(comm);

      if (k < 1 || k > n) fail(`community count ${k} out of range`);

      // Modularity is reported (not floor-gated): an absolute threshold
      // measures graph structure, not parity, and is meaningless on
      // tiny/weakly-clustered graphs. Determinism above + the exact
      // parse/radii checks are the real nets; there's no JS Louvain
      // left to cross-check quality against.
      const qRust = modularity(n, js.edgesFlat, comm);
      const status = failures.some((f) => f.startsWith(`${ex.label}:`)) ? "FAIL" : "ok";

      console.info(
        `  ${status.padEnd(4)} ${ex.label.padEnd(14)} n=${String(n).padStart(5)} ` +
          `comm=${String(k).padStart(4)}  orphans=${String(rustOrph.length).padStart(4)}  ` +
          `Q=${qRust.toFixed(3)}`,
      );
    } finally {
      rust.free();
      rust2.free();
    }
  }

  console.info();

  if (failures.length > 0) {
    console.error(`[parity] ${failures.length} mismatch(es):`);

    for (const f of failures) console.error(`  - ${f}`);

    process.exit(1);
  }

  console.info(
    `[parity] ${EXAMPLES.length} examples agree (parse/radii: JS ≡ Rust) ` +
      `+ orphan & cycle fixtures pass.`,
  );
}

main();
