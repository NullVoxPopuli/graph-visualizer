/**
 * Layout simulation benchmark.
 *
 * Times the Rust/WASM force-directed layout (the exact pipeline the app
 * ships) across the real example graphs, or a synthetic size sweep.
 *
 * Run:  pnpm bench:layout            (mitata, real examples)
 *       pnpm bench:layout 200,2000   (mitata, synthetic sizes)
 *       pnpm bench:layout smoke      (one run/size, prints ms + sanity)
 *
 * Node 24+ runs this `.ts` directly — no loader needed (see package.json).
 *
 * Requires the WASM backend to be built first (`pnpm build:wasm`); there
 * is no JS fallback — the simulation lives only in Rust.
 */
import { bench, group, run, summary } from "mitata";

import { loadAllExamples } from "./examples.ts";
import { describeGraph, generateLayoutInit } from "./graph-gen.ts";
import { loadWasmLayout, type WasmLayout } from "./wasm-backend.ts";

import type { LayoutInit } from "../app/lib/layout-types.ts";

const DEFAULT_SIZES = [200, 1_000, 3_000, 6_000];

function parseSizes(arg: string | undefined): number[] {
  if (!arg || arg === "smoke") return DEFAULT_SIZES;

  return arg
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * Cheap sanity gate so a "fast" change that produces garbage can't look
 * like a win: every coordinate must be finite and the cloud must have
 * actually spread out (not collapsed to a point).
 */
function assertSanePositions(positions: Float32Array, nodeCount: number, label: string): void {
  if (positions.length !== nodeCount * 2) {
    throw new Error(`${label}: expected ${nodeCount * 2} coords, got ${positions.length}`);
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < positions.length; i++) {
    const v = positions[i]!;

    if (!Number.isFinite(v)) throw new Error(`${label}: non-finite coord at ${i}`);

    if (i % 2 === 0) {
      if (v < minX) minX = v;
      if (v > maxX) maxX = v;
    } else {
      if (v < minY) minY = v;
      if (v > maxY) maxY = v;
    }
  }

  const spread = Math.max(maxX - minX, maxY - minY);

  if (spread < 1) throw new Error(`${label}: positions collapsed (spread ${spread.toFixed(3)})`);
}

/**
 * Layout quality proxy: how cleanly communities separate in the result.
 * For each community we take its centroid and mean node→centroid radius
 * (spread); separation = (mean distance to the nearest *other* community
 * centroid) / (mean community spread). >1 means clusters are, on
 * average, farther apart than they are wide — i.e. visually distinct.
 * Bigger is better. This is the "are the communities good" check.
 */
function clusterSeparation(positions: Float32Array, communities: Int32Array): number {
  const n = communities.length;
  const ids = [...new Set(Array.from(communities))];
  const idx = new Map(ids.map((c, i) => [c, i]));
  const k = ids.length;

  if (k < 2) return Infinity;

  const sx = new Float64Array(k);
  const sy = new Float64Array(k);
  const cnt = new Int32Array(k);

  for (let i = 0; i < n; i++) {
    const ci = idx.get(communities[i]!)!;

    sx[ci]! += positions[2 * i]!;
    sy[ci]! += positions[2 * i + 1]!;
    cnt[ci]!++;
  }

  for (let c = 0; c < k; c++) {
    sx[c]! /= cnt[c]! || 1;
    sy[c]! /= cnt[c]! || 1;
  }

  const spread = new Float64Array(k);

  for (let i = 0; i < n; i++) {
    const ci = idx.get(communities[i]!)!;
    const dx = positions[2 * i]! - sx[ci]!;
    const dy = positions[2 * i + 1]! - sy[ci]!;

    spread[ci]! += Math.sqrt(dx * dx + dy * dy);
  }

  for (let c = 0; c < k; c++) spread[c]! /= cnt[c]! || 1;

  let ratioSum = 0;

  for (let a = 0; a < k; a++) {
    let nearest = Infinity;

    for (let b = 0; b < k; b++) {
      if (a === b) continue;

      const dx = sx[a]! - sx[b]!;
      const dy = sy[a]! - sy[b]!;

      nearest = Math.min(nearest, Math.sqrt(dx * dx + dy * dy));
    }

    ratioSum += nearest / (spread[a]! || 1);
  }

  return ratioSum / k;
}

interface Case {
  label: string;
  init: LayoutInit;
}

/**
 * Benchmark cases. Default = the real shipped examples (parsed + Louvain
 * + radii, exactly as the app builds them) so the bench measures what
 * users actually run, the 5k "large" graph included. A numeric arg
 * (`200,3000`) switches to the synthetic generator for clean size sweeps.
 */
function buildCases(arg: string | undefined): Case[] {
  if (arg && arg !== "smoke" && /\d/.test(arg)) {
    return parseSizes(arg).map((n) => {
      const init = generateLayoutInit({ nodeCount: n });

      return { label: describeGraph(init), init };
    });
  }

  return loadAllExamples().map((e) => ({
    label: `${e.label} — ${describeGraph(e.init)}`,
    init: e.init,
  }));
}

function smoke(cases: Case[], wasm: WasmLayout): void {
  for (const { label, init } of cases) {
    const n = init.nodeCount;

    console.info(`\n${label}`);

    const t1 = performance.now();
    const wasmPos = wasm.run(init);
    const wasmMs = performance.now() - t1;

    assertSanePositions(wasmPos, n, `WASM@${label}`);

    const sep = clusterSeparation(wasmPos, init.communities);

    console.info(`  WASM  ${wasmMs.toFixed(1).padStart(9)} ms   cluster-sep ${sep.toFixed(2)}`);
  }
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const wasm = await loadWasmLayout();

  if (!wasm) {
    console.error("[bench] WASM backend not built. Run `pnpm build:wasm` first.");
    process.exitCode = 1;

    return;
  }

  if (arg === "smoke") {
    smoke(buildCases(process.argv[3]), wasm);

    return;
  }

  for (const { label, init } of buildCases(arg)) {
    group(label, () => {
      summary(() => {
        bench("WASM", () => {
          wasm.run(init);
        });
      });
    });
  }

  await run();
}

await main();
