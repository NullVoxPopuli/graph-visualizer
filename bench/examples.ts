/**
 * Load the real example graphs (the ones shipped in `public/examples/`
 * and surfaced on the landing page) into `LayoutInit`s, replicating the
 * exact app pipeline: the JSON goes into a resident Rust `GraphSession`
 * which does parse → Louvain → degree-driven radii, exactly as the app's
 * session worker does. This makes the benchmark measure what users
 * actually run, including the 5k-node "large" example, instead of only
 * the synthetic generator.
 *
 * The `--target nodejs` WASM build (`crates/layout-wasm/pkg-node`,
 * produced by `pnpm build:wasm`) initializes synchronously on `require`,
 * so this stays a synchronous loader and the bench's `buildCases` doesn't
 * have to become async.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { EXAMPLES } from "#lib/examples";

import { DEFAULT_LAYOUT_PARAMS } from "./graph-gen.ts";

import type { LayoutInit } from "#lib/layout-types";

interface GraphSessionCtor {
  load(json: string): {
    node_count(): number;
    edges_flat(): Int32Array;
    communities(): Int32Array;
    radii(): Float32Array;
    free(): void;
  };
}

const require = createRequire(import.meta.url);
let sessionCtor: GraphSessionCtor | null = null;

/**
 * Lazily `require` the Node WASM build. Throws a clear message if it
 * hasn't been built — there is no JS fallback for community detection
 * anymore (the app runs Louvain in Rust).
 */
function graphSession(): GraphSessionCtor {
  if (sessionCtor) return sessionCtor;

  const spec = fileURLToPath(
    new URL("../crates/layout-wasm/pkg-node/layout_wasm.js", import.meta.url),
  );

  let mod: { GraphSession?: GraphSessionCtor; default?: { GraphSession?: GraphSessionCtor } };

  try {
    mod = require(spec) as typeof mod;
  } catch {
    throw new Error("[bench] WASM backend not built. Run `pnpm build:wasm` first.");
  }

  const ctor = mod.GraphSession ?? mod.default?.GraphSession;

  if (!ctor) throw new Error("[bench] pkg-node is missing the GraphSession export.");

  sessionCtor = ctor;

  return ctor;
}

export interface ExampleCase {
  label: string;
  init: LayoutInit;
}

/** Resolve a `/examples/x.json` manifest URL to its on-disk path. */
function examplePath(url: string): string {
  return fileURLToPath(new URL(`../public${url}`, import.meta.url));
}

export function loadExample(label: string, url: string): ExampleCase {
  const text = readFileSync(examplePath(url), "utf8");
  const session = graphSession().load(text);

  try {
    return {
      label,
      init: {
        nodeCount: session.node_count(),
        edges: Int32Array.from(session.edges_flat()),
        communities: Int32Array.from(session.communities()),
        radii: Float32Array.from(session.radii()),
        ...DEFAULT_LAYOUT_PARAMS,
      },
    };
  } finally {
    session.free();
  }
}

/** Every shipped example, smallest-first, as benchmark cases. */
export function loadAllExamples(): ExampleCase[] {
  return EXAMPLES.map((e) => loadExample(e.label, e.url)).sort(
    (a, b) => a.init.nodeCount - b.init.nodeCount,
  );
}
