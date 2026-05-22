/**
 * Generator for `public/examples/large-monorepo.json`.
 *
 * Output shape mirrors `monorepo.json`:
 *
 *  - 100 package nodes (`type: "package"`). Naming follows a deliberate
 *    scope-and-domain pattern (`@scope/domain-sub-NNN`) so the LCP
 *    clusterer has natural prefix structure to find without any
 *    hard-coded separator.
 *  - Per-package size varies: a long tail of small packages (2–8 files),
 *    a middle band of medium packages (10–30 files), and a few hub
 *    packages (30–70 files).
 *  - Package → file edges use `edgeType: "contain"`.
 *  - File → file edges use four edge types — `import:value`,
 *    `import:type`, `import:dynamic`, and `reexport` — distributed
 *    realistically.
 *  - Cycles are explicitly injected at the *file* level: a handful of
 *    short 2-/3-/4-node cycles plus a few longer 6-/10-/15-node ones,
 *    deliberately spanning multiple packages so the contraction step
 *    surfaces real package-level cycles too.
 *
 * Deterministic: a fixed PRNG seed keeps the output stable between
 * runs so the JSON diffs cleanly when we re-generate after tuning.
 *
 *   Run:  node scripts/gen-large-monorepo.mjs
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT_PATH = fileURLToPath(new URL("../public/examples/large-monorepo.json", import.meta.url));

const PACKAGE_COUNT = 100;
const SEED = 0x4d_4f_4e_4f; // "MONO"

// Stable PRNG (mulberry32) so re-running yields byte-identical output.
function makeRng(seed) {
  let a = seed >>> 0;

  return function next() {
    a = (a + 0x6d_2b_79_f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);

    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const rng = makeRng(SEED);
const randInt = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = (arr) => arr[Math.floor(rng() * arr.length)];

// Scope / domain / subdomain pool — keeps names structured so the LCP
// clusterer sees natural branching points. Combinations are bounded
// (5 × 14 × 8 = 560 distinct templates) — far more than the 100
// packages we need, so collisions don't matter.
const SCOPES = ["@acme", "@beta", "@gamma", "@core", "@infra"];
const DOMAINS = [
  "api",
  "ui",
  "db",
  "auth",
  "billing",
  "search",
  "queue",
  "storage",
  "telemetry",
  "config",
  "common",
  "platform",
  "edge",
  "tools",
];
const SUBS = ["client", "server", "shared", "util", "model", "view", "service", "router"];

function packageName(i) {
  // Round-robin through scopes / domains / subs so we get an even
  // spread of prefixes. The trailing 3-digit index keeps names
  // unique even when scope+domain+sub collide.
  const scope = SCOPES[i % SCOPES.length];
  const domain = DOMAINS[Math.floor(i / SCOPES.length) % DOMAINS.length];
  const sub = SUBS[Math.floor(i / (SCOPES.length * DOMAINS.length)) % SUBS.length];

  return `${scope}/${domain}-${sub}-${String(i).padStart(3, "0")}`;
}

// Size buckets, spanning **5 to 1000 files** so the layout, cluster,
// and cycle paths all see a realistic long-tail distribution:
//
//   1 mega       1000     files
//   1 huge       500–800
//   2 very-large 200–500
//  10 large      80–200
//  30 medium     20–60
//  56 small      5–15
//
// Total works out to ~5–6k files. The first few indices have pinned
// buckets (instead of randomly sampling from one wide range) so the
// 500-and-up region stays populated even when the rng's first few
// draws happen to land low.
function packageSize(i) {
  if (i === 0) return 1000;
  if (i === 1) return randInt(500, 800);
  if (i < 4) return randInt(200, 500);
  if (i < 14) return randInt(80, 200);
  if (i < 44) return randInt(20, 60);

  return randInt(5, 15);
}

// Per-package, generate `count` file names with realistic-ish nested
// paths so LCP clustering at deeper segments finds intra-package
// structure too. Files live under `src/`, `test/`, or `lib/` with
// up to one nested subdirectory.
const SRC_DIRS = ["src", "lib", "internal"];
const NESTED = ["", "core", "api", "io", "ui", "util", "model", "runtime"];
const NAMES = [
  "index",
  "client",
  "server",
  "router",
  "store",
  "actions",
  "events",
  "schema",
  "types",
  "errors",
  "config",
  "logger",
  "helpers",
  "constants",
  "guards",
  "filters",
  "selectors",
  "reducer",
  "context",
  "session",
  "auth",
  "user",
  "token",
  "cache",
  "queue",
  "worker",
  "stream",
  "buffer",
  "encoder",
  "decoder",
  "parser",
  "writer",
  "reader",
  "lexer",
  "ast",
  "ir",
];

function fileNamesForPackage(pkg, count) {
  const out = [];
  const seen = new Set();

  while (out.length < count) {
    const dir = pick(SRC_DIRS);
    const nested = pick(NESTED);
    const name = pick(NAMES);
    const ext = rng() < 0.85 ? "ts" : "tsx";
    const path = nested ? `${dir}/${nested}/${name}.${ext}` : `${dir}/${name}.${ext}`;

    if (seen.has(path)) continue;
    seen.add(path);
    out.push(`${pkg}/${path}`);
  }

  return out;
}

const packages = [];
const filesByPkg = [];
const allFiles = [];

for (let i = 0; i < PACKAGE_COUNT; i++) {
  const name = packageName(i);
  const size = packageSize(i);
  const files = fileNamesForPackage(name, size);

  packages.push(name);
  filesByPkg.push(files);

  for (const f of files) allFiles.push(f);
}

// Edge-type pool for file→file imports. Distribution skews toward
// runtime `import:value`, with a meaningful share of `import:type`
// (matters for TS dependency graphs because they don't survive emit),
// a tail of dynamic imports, and reexports for re-export barrels.
function pickEdgeType() {
  const r = rng();

  if (r < 0.6) return "import:value";
  if (r < 0.85) return "import:type";
  if (r < 0.95) return "reexport";

  return "import:dynamic";
}

// `nodesById` accumulates one entry per node (package or file). Each
// entry's `edges` array gathers the outgoing edges we'll emit. We add
// edges into this rather than into a separate list so package→file
// `contain` edges and file→file imports share one structure.
const nodesById = new Map();

function addNode(id, type) {
  nodesById.set(id, { id, label: id, type, edges: [] });
}
function addEdge(from, to, edgeType) {
  const node = nodesById.get(from);

  if (!node) return;
  // Drop self-loops up front — they wouldn't survive the parser
  // either, but it's cleaner not to emit them.
  if (from === to) return;
  node.edges.push({ nodeId: to, edgeType });
}

for (let i = 0; i < packages.length; i++) {
  const pkg = packages[i];

  addNode(pkg, "package");
  for (const f of filesByPkg[i]) addNode(f, "file");
}

// Package → file "contain" edges.
for (let i = 0; i < packages.length; i++) {
  const pkg = packages[i];

  for (const f of filesByPkg[i]) addEdge(pkg, f, "contain");
}

// File → file import edges. Bias intra-package so the graph has
// strong clusters; the cross-package edges drive the inter-package
// structure the LCP clusterer's outer segments care about.
const INTRA_PROB = 0.65;

function pickTargetFile(fromIdx, fromPkg) {
  // 65% intra-package (any other file in the same package), 35%
  // cross-package (any other file in the whole monorepo).
  if (rng() < INTRA_PROB) {
    const siblings = filesByPkg[fromPkg];

    if (siblings.length <= 1) return pick(allFiles);

    let pickIdx;

    do {
      pickIdx = Math.floor(rng() * siblings.length);
    } while (siblings[pickIdx] === allFiles[fromIdx]);

    return siblings[pickIdx];
  }

  return allFiles[Math.floor(rng() * allFiles.length)];
}

// Map a global file index back to the package it belongs to. We
// build this lookup once so the import-picker doesn't have to scan.
const fileToPkg = new Int32Array(allFiles.length);
let cursor = 0;

for (let i = 0; i < filesByPkg.length; i++) {
  for (let j = 0; j < filesByPkg[i].length; j++) fileToPkg[cursor++] = i;
}

for (let i = 0; i < allFiles.length; i++) {
  const file = allFiles[i];
  const pkg = fileToPkg[i];
  // Out-degree distribution: most files have 2–5 imports, a tail
  // has 6–12. Avoids the trivial "every file imports exactly K"
  // shape that won't stress the layout.
  const r = rng();
  const degree = r < 0.85 ? randInt(2, 5) : randInt(6, 12);
  const seen = new Set();

  for (let k = 0; k < degree; k++) {
    const target = pickTargetFile(i, pkg);

    if (!target || target === file) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    addEdge(file, target, pickEdgeType());
  }
}

// Inject a deliberate set of cycles at the file level. Each entry
// is a closed chain `a → b → … → a`; lengths cover 2, 3, 4, 6, 10,
// 15 so the cycles panel has something interesting to render. We
// pull random files from the whole population so a cycle naturally
// spans packages — the contraction step then surfaces real
// package-level loops in the visualizer.
function injectCycle(length) {
  if (allFiles.length < length) return;

  const picks = new Set();

  while (picks.size < length) picks.add(Math.floor(rng() * allFiles.length));

  const arr = [...picks];

  for (let i = 0; i < arr.length; i++) {
    const from = allFiles[arr[i]];
    const to = allFiles[arr[(i + 1) % arr.length]];

    addEdge(from, to, pickEdgeType());
  }
}

// Lengths chosen to span the cycles panel's interesting range: short
// (2–4) for the common "circular deps" case, medium (6) for the
// "tangled across a couple packages", and longer (10/15) so the
// shortest-cycle algorithm has something taller to surface.
for (const len of [2, 2, 3, 3, 4, 4, 6, 10, 15]) injectCycle(len);

const out = {
  nodes: Array.from(nodesById.values()).map(({ id, label, type, edges }) => ({
    id,
    label,
    type,
    edges,
  })),
};

writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + "\n");

const packageCount = out.nodes.filter((n) => n.type === "package").length;
const fileCount = out.nodes.filter((n) => n.type === "file").length;
const edgeCount = out.nodes.reduce((sum, n) => sum + n.edges.length, 0);

console.info(
  `[gen-large-monorepo] wrote ${OUT_PATH}: ${packageCount} packages, ${fileCount} files, ${edgeCount} edges`,
);
