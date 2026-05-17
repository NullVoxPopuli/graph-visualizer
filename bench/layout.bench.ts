/**
 * Layout simulation benchmark.
 *
 * Times `runLayoutCore` (the production d3-force pipeline, extracted from
 * the worker) across a range of graph sizes, and — once the Rust/WASM
 * backend is built — the WASM port head-to-head on the *same* generated
 * graphs.
 *
 * Run:  pnpm bench:layout            (mitata, all sizes)
 *       pnpm bench:layout 200,2000   (mitata, custom sizes)
 *       pnpm bench:layout smoke      (one run/size, prints ms + sanity)
 *
 * Node 24 runs this `.ts` directly via `tsx` (see package.json).
 */
import { bench, group, run, summary } from "mitata";

import { type LayoutInit, runLayoutCore } from "#lib/layout-core";

import { describeGraph, generateLayoutInit } from "./graph-gen.ts";
import { loadWasmLayout, type WasmLayout } from "./wasm-backend.ts";

const DEFAULT_SIZES = [200, 1_000, 3_000, 6_000];

function parseSizes(arg: string | undefined): number[] {
  if (!arg || arg === "smoke") return DEFAULT_SIZES;

  return arg
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * Cheap sanity gate so a "fast" backend that produces garbage can't look
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

async function runJs(init: LayoutInit): Promise<Float32Array> {
  return runLayoutCore(init, { yieldBetweenBatches: false });
}

async function smoke(sizes: number[], wasm: WasmLayout | null): Promise<void> {
  // `BENCH_WASM_ONLY=1` skips the (slow) JS baseline — for quick WASM-only
  // probing (per-phase profiling builds, parallel-vs-serial sweeps).
  const wasmOnly = process.env["BENCH_WASM_ONLY"] === "1";

  for (const size of sizes) {
    const init = generateLayoutInit({ nodeCount: size });

    console.info(`\n${describeGraph(init)}`);

    let jsMs = NaN;

    if (!wasmOnly) {
      const t0 = performance.now();
      const jsPos = await runJs(init);

      jsMs = performance.now() - t0;
      assertSanePositions(jsPos, size, `JS@${size}`);
      console.info(`  JS    ${jsMs.toFixed(1).padStart(9)} ms`);
    }

    if (wasm) {
      const t1 = performance.now();
      const wasmPos = wasm.run(init);
      const wasmMs = performance.now() - t1;

      assertSanePositions(wasmPos, size, `WASM@${size}`);

      const vs = Number.isFinite(jsMs) ? `   (${(jsMs / wasmMs).toFixed(2)}× vs JS)` : "";

      console.info(`  WASM  ${wasmMs.toFixed(1).padStart(9)} ms${vs}`);
    }
  }
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const sizes = parseSizes(arg);
  // The WASM backend is optional: until `pnpm build:wasm` has produced the
  // pkg, this resolves to null and the bench just reports the JS baseline.
  const wasm = await loadWasmLayout();

  if (!wasm) {
    console.info("[bench] WASM backend not built — JS baseline only. Run `pnpm build:wasm`.\n");
  }

  if (arg === "smoke") {
    // `smoke` alone → default sizes; `smoke 3000,5000` → those sizes.
    await smoke(parseSizes(process.argv[3]), wasm);

    return;
  }

  for (const size of sizes) {
    const init = generateLayoutInit({ nodeCount: size });

    group(describeGraph(init), () => {
      summary(() => {
        bench(`JS    @ ${size}`, async () => {
          await runJs(init);
        });

        if (wasm) {
          bench(`WASM  @ ${size}`, () => {
            wasm.run(init);
          });
        }
      });
    });
  }

  await run();
}

await main();
