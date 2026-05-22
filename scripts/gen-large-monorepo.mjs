/**
 * Generator for `public/examples/large-monorepo.json`.
 *
 * Output shape mirrors `monorepo.json` but the *topology* is built to
 * look tree-like in the force-directed layout, not a hairball:
 *
 *  - **Package layers.** Each of the 100 packages is assigned a layer
 *    0..3. Layer 0 holds the foundation (and happens to be where the
 *    mega / huge / large size buckets land — the "deeply depended-on"
 *    libraries). A layer-N package depends on a small handful of
 *    packages drawn only from layers 0..N-1, so the package-level
 *    dependency graph is a strict DAG.
 *  - **File tiers within a package.** Each file is assigned a tier
 *    1..4 by its role (entry / public api / core+model / util). File
 *    paths reflect the tier:
 *      tier 1 → `<pkg>/index.ts` (exactly one per package)
 *      tier 2 → `<pkg>/src/{api,router}/…`
 *      tier 3 → `<pkg>/src/{core,model}/…` or `<pkg>/lib/…`
 *      tier 4 → `<pkg>/internal/{util,runtime}/…`
 *  - **Import rules** make the file graph a DAG:
 *      intra-package: tier T imports only from tier > T (downward)
 *      cross-package: only tier 1–2 files (the package's "public
 *        surface") import from tier 1–2 files of packages this one
 *        depends on
 *    No back-edges anywhere, so the natural-mode result is a clean
 *    multi-rooted forest the force-directed layout can actually
 *    untangle into something tree-shaped.
 *  - **Cycles** are still injected at the file level so the cycles
 *    panel has something to surface — lengths 2 / 3 / 4 / 6 / 10 /
 *    15, spanning packages — but they're additive on top of the DAG
 *    skeleton, not woven through it.
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
// The first few indices have pinned buckets (instead of randomly
// sampling from one wide range) so the 500-and-up region stays
// populated even when the rng's first few draws happen to land low.
// Also pins the mega/huge packages into layer 0 — they read as the
// "foundation libs that everyone depends on" in the layered DAG.
function packageSize(i) {
  if (i === 0) return 1000;
  if (i === 1) return randInt(500, 800);
  if (i < 4) return randInt(200, 500);
  if (i < 14) return randInt(80, 200);
  if (i < 44) return randInt(20, 60);

  return randInt(5, 15);
}

// 4 layers, ~25 packages each (so the mega/huge packages at indices
// 0/1 sit in layer 0). Layer-N packages depend only on packages from
// layers 0..N-1, making the package-level dep graph a strict DAG.
const LAYER_COUNT = 4;

function packageLayer(i) {
  return Math.floor((i * LAYER_COUNT) / PACKAGE_COUNT);
}

// Pick `numDeps` random packages from strictly lower layers (or all
// of them if there aren't enough). Layer 0 packages have no deps.
function packageDeps(i, byLayer) {
  const layer = packageLayer(i);

  if (layer === 0) return [];

  const candidates = [];

  for (let l = 0; l < layer; l++) {
    for (const j of byLayer[l]) candidates.push(j);
  }
  const want = Math.min(randInt(2, 5), candidates.length);
  const deps = new Set();

  while (deps.size < want) {
    deps.add(candidates[Math.floor(rng() * candidates.length)]);
  }

  return [...deps];
}

// File-tier paths. Tier names mirror real codebases so the LCP
// clusterer also has tier-level segments to cut on if the user dials
// the depth up that far.
const TIER2_DIRS = ["src/api", "src/router"];
const TIER3_DIRS = ["src/core", "src/model", "lib"];
const TIER4_DIRS = ["internal/util", "internal/runtime", "lib/util"];
const TIER2_NAMES = ["api", "router", "endpoints", "routes", "controller", "handler"];
const TIER3_NAMES = ["core", "model", "service", "store", "context", "session"];
const TIER4_NAMES = [
  "util",
  "logger",
  "helpers",
  "config",
  "constants",
  "guards",
  "errors",
  "buffer",
  "reader",
  "writer",
  "encoder",
  "decoder",
  "parser",
  "queue",
  "cache",
];

function pathForTier(pkg, tier, idx) {
  if (tier === 1) return `${pkg}/index.ts`;

  const dirs = tier === 2 ? TIER2_DIRS : tier === 3 ? TIER3_DIRS : TIER4_DIRS;
  const names = tier === 2 ? TIER2_NAMES : tier === 3 ? TIER3_NAMES : TIER4_NAMES;
  // Mixed-radix: decompose `idx` into (dirIdx, nameIdx, suffix) so
  // each tuple is uniquely determined. Going via `idx % dirs.length`
  // *and* `idx % names.length` lets the two indices collide whenever
  // `lcm(d, n) < d * n`, which silently produced duplicate paths
  // within large packages (the 1000-file mega lost half its files
  // to collisions on the previous build).
  const dirIdx = idx % dirs.length;
  const nameIdx = Math.floor(idx / dirs.length) % names.length;
  const suffix = Math.floor(idx / (dirs.length * names.length));
  const dir = dirs[dirIdx];
  const name = names[nameIdx];
  const ext = rng() < 0.85 ? "ts" : "tsx";
  const final = suffix > 0 ? `${name}-${String(suffix).padStart(2, "0")}` : name;

  return `${pkg}/${dir}/${final}.${ext}`;
}

// Files per package, with explicit tier assignments so the import
// generator below can enforce the downward-only rule. Exactly one
// tier-1 (`index.ts`) per package; the remainder distribute 15%
// tier 2, 25% tier 3, the rest tier 4.
function filesForPackage(pkg, count) {
  const files = [{ path: `${pkg}/index.ts`, tier: 1 }];

  if (count <= 1) return files;

  const rest = count - 1;
  const n2 = Math.max(1, Math.floor(rest * 0.15));
  const n3 = Math.max(1, Math.floor(rest * 0.25));
  const n4 = rest - n2 - n3;

  for (let k = 0; k < n2; k++) files.push({ path: pathForTier(pkg, 2, k), tier: 2 });
  for (let k = 0; k < n3; k++) files.push({ path: pathForTier(pkg, 3, k), tier: 3 });
  for (let k = 0; k < n4; k++) files.push({ path: pathForTier(pkg, 4, k), tier: 4 });

  return files;
}

const packages = [];
const filesByPkg = [];

for (let i = 0; i < PACKAGE_COUNT; i++) {
  const name = packageName(i);
  const size = packageSize(i);
  const files = filesForPackage(name, size);

  packages.push(name);
  filesByPkg.push(files);
}

// Group package indices by layer so `packageDeps` can pull from
// lower layers cheaply.
const packagesByLayer = Array.from({ length: LAYER_COUNT }, () => []);

for (let i = 0; i < PACKAGE_COUNT; i++) packagesByLayer[packageLayer(i)].push(i);

const depsByPkg = packages.map((_, i) => packageDeps(i, packagesByLayer));

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
  for (const f of filesByPkg[i]) addNode(f.path, "file");
}

// Package → file "contain" edges.
for (let i = 0; i < packages.length; i++) {
  const pkg = packages[i];

  for (const f of filesByPkg[i]) addEdge(pkg, f.path, "contain");
}

// File → file imports. Two rules:
//   1. Intra-package: a tier-T file picks a few targets from the
//      strictly-deeper tiers of the same package. Tier 4 leaves
//      have no intra-package imports.
//   2. Cross-package: a tier-1 or tier-2 file (the package's public
//      surface) picks a few targets from the tier-1/2 files of
//      depended-on packages. Deeper-tier files don't reach across.
// Both rules together guarantee the file graph is a DAG before any
// cycle injection below.
for (let pkgIdx = 0; pkgIdx < packages.length; pkgIdx++) {
  const myFiles = filesByPkg[pkgIdx];
  const myDeps = depsByPkg[pkgIdx];

  for (let fi = 0; fi < myFiles.length; fi++) {
    const file = myFiles[fi];
    const seen = new Set();

    // Intra-package: deeper tiers only.
    const intraCandidates = myFiles.filter((f) => f.tier > file.tier);
    const intraWant = Math.min(randInt(0, 4), intraCandidates.length);

    for (let k = 0; k < intraWant; k++) {
      const pickIdx = Math.floor(rng() * intraCandidates.length);
      const target = intraCandidates[pickIdx];

      if (target.path === file.path || seen.has(target.path)) continue;
      seen.add(target.path);
      addEdge(file.path, target.path, pickEdgeType());
    }

    // Cross-package: only the public surface (tier ≤ 2) of this
    // package reaches into the public surface of depended packages.
    if (file.tier <= 2 && myDeps.length > 0) {
      const crossWant = randInt(1, 3);

      for (let k = 0; k < crossWant; k++) {
        const depPkgIdx = myDeps[Math.floor(rng() * myDeps.length)];
        const depFiles = filesByPkg[depPkgIdx].filter((f) => f.tier <= 2);

        if (depFiles.length === 0) continue;
        const target = depFiles[Math.floor(rng() * depFiles.length)];

        if (seen.has(target.path)) continue;
        seen.add(target.path);
        addEdge(file.path, target.path, pickEdgeType());
      }
    }
  }
}

// Inject a deliberate set of cycles at the file level. Each entry
// is a closed chain `a → b → … → a`; lengths cover 2, 3, 4, 6, 10,
// 15 so the cycles panel has something interesting to render. These
// are *added on top* of the DAG skeleton above — small, sparse,
// deliberate cycles instead of woven through the whole graph.
//
// Picking from the full file population means a cycle naturally
// spans packages, and the contraction step surfaces real
// package-level loops in the visualizer.
const allFilePaths = [];

for (const fs of filesByPkg) for (const f of fs) allFilePaths.push(f.path);

function injectCycle(length) {
  if (allFilePaths.length < length) return;

  const picks = new Set();

  while (picks.size < length) picks.add(Math.floor(rng() * allFilePaths.length));

  const arr = [...picks];

  for (let i = 0; i < arr.length; i++) {
    const from = allFilePaths[arr[i]];
    const to = allFilePaths[arr[(i + 1) % arr.length]];

    addEdge(from, to, pickEdgeType());
  }
}

// Lengths chosen to span the cycles panel's interesting range: short
// (2–4) for the common "circular deps" case, medium (6) for
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
