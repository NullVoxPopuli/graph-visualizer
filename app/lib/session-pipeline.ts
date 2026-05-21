/**
 * Main-thread driver for one resident `graph-session.worker`.
 *
 * One instance owns one worker for the lifetime of one loaded graph: the
 * JSON is parsed into WASM once (`load`), then clustering and layout are
 * cheap in-place queries. When the user loads a *different* graph the
 * service throws this away (`dispose`, which terminates the worker and
 * frees the WASM session) and makes a new one.
 *
 * Cancellation model — note this differs from the old terminate-to-cancel
 * workers. The session is resident, so we can't terminate to cancel a
 * superseded run without losing it. Instead:
 *
 *  - **Clustering** (`analyze`) calls are fast (Louvain) and serialized by
 *    Comlink; we just await the latest.
 *  - **Layout** is the expensive, synchronous-in-WASM step. `layout()`
 *    keeps at most one run in flight and always converges to the most
 *    recent request: a call made while a run is in flight is queued, and
 *    only the newest queued request actually runs when the current one
 *    finishes (intermediate slider values during a drag collapse away).
 *    Superseded queued calls' promises are abandoned — the visualizer
 *    service already drops stale pipeline promises by reference, so
 *    nothing ever awaits them.
 *
 * Test-waiter integration: `load` + every query (`analyze`,
 * `findOrphans`, `hasAnyOrphan`, `hasAnyCycle`, `rawCycles`) is wrapped
 * in `waitForPromise`, so `settled()` / `await render()` block until the
 * worker result the UI consumes is in — tests assert on semantics, no
 * `waitUntil` polling. `waitForPromise` compiles to a plain passthrough
 * in production builds (zero overhead). `layout` is deliberately *not*
 * wrapped: its superseded coalesced promises are abandoned by design
 * and never settle, which would leave a test waiter pending forever.
 */
import { waitForPromise } from "@ember/test-waiters";

import * as Comlink from "comlink";

import type {
  LayoutParams,
  LayoutProgress,
  SessionEngine,
  SessionInfo,
} from "#lib/graph-session.worker";

export type { LayoutParams, SessionInfo } from "#lib/graph-session.worker";

interface QueuedLayout {
  params: LayoutParams;
  onProgress: LayoutProgress | null;
  resolve: (positions: Float32Array) => void;
  reject: (err: unknown) => void;
}

export class SessionPipeline {
  #worker: Worker;
  #engine: Comlink.Remote<SessionEngine>;
  /** Resolves once the graph is parsed into WASM. `analyze`/`layout`
   *  chain off this so callers don't have to sequence load themselves. */
  #loaded: Promise<SessionInfo>;

  #layoutBusy = false;
  #queuedLayout: QueuedLayout | null = null;

  constructor(text: string) {
    this.#worker = new Worker(new URL("./graph-session.worker.ts", import.meta.url), {
      type: "module",
    });
    this.#engine = Comlink.wrap<SessionEngine>(this.#worker);
    this.#loaded = waitForPromise(this.#engine.load(text), "graph-session:load");
  }

  /**
   * Community assignment for the requested clustering. `labelCommunities`
   * is the JS label-prefix assignment (only used when `clusterByLabel`);
   * otherwise Rust Louvain runs at `resolution`.
   */
  analyze(opts: {
    clusterByLabel: boolean;
    resolution: number;
    labelCommunities: Int32Array | null;
  }): Promise<SessionInfo> {
    return waitForPromise(
      this.#loaded.then(() => {
        if (opts.clusterByLabel) {
          if (!opts.labelCommunities) {
            throw new Error("SessionPipeline.analyze: clusterByLabel needs labelCommunities");
          }

          return this.#engine.setCommunities(opts.labelCommunities);
        }

        return this.#engine.setResolution(opts.resolution);
      }),
      "graph-session:analyze",
    );
  }

  /**
   * Run the layout. At most one worker run is outstanding; a call made
   * while one is running supersedes any other waiting call and runs once
   * the current run completes (latest-wins; see the class doc).
   */
  layout(params: LayoutParams, onProgress: LayoutProgress | null): Promise<Float32Array> {
    return new Promise<Float32Array>((resolve, reject) => {
      // Latest wins: a still-queued (not yet started) request is replaced
      // and its promise abandoned — the service never awaits stale ones.
      this.#queuedLayout = { params, onProgress, resolve, reject };
      void this.#pumpLayout();
    });
  }

  async #pumpLayout(): Promise<void> {
    if (this.#layoutBusy || !this.#queuedLayout) return;

    this.#layoutBusy = true;

    try {
      await this.#loaded;

      // Re-read at start (not at enqueue): collapses every slider value
      // that arrived while the previous run was in flight to just the
      // newest one.
      while (this.#queuedLayout) {
        const job = this.#queuedLayout;

        this.#queuedLayout = null;

        try {
          const positions = await this.#engine.layout(
            job.params,
            job.onProgress ? Comlink.proxy(job.onProgress) : null,
          );

          job.resolve(positions);
        } catch (err) {
          job.reject(err);
        }
      }
    } finally {
      this.#layoutBusy = false;
    }
  }

  /**
   * Transitively-orphaned node indices. Cheap O(N+E) Rust pass on the
   * resident graph — the analysis isn't duplicated in JS and the graph
   * never re-crosses the worker boundary. `hiddenEdgeTypeIds`/
   * `rootIndices` empty ⇒ unfiltered.
   */
  findOrphans(hiddenEdgeTypeIds: Int32Array, rootIndices: Int32Array): Promise<Int32Array> {
    return waitForPromise(
      this.#loaded.then(() => this.#engine.findOrphans(hiddenEdgeTypeIds, rootIndices)),
      "graph-session:find-orphans",
    );
  }

  /** Does the resident graph have any orphan under this edge-type
   *  filter? (empty ⇒ unfiltered.) */
  hasAnyOrphan(hiddenEdgeTypeIds: Int32Array): Promise<boolean> {
    return waitForPromise(
      this.#loaded.then(() => this.#engine.hasAnyOrphan(hiddenEdgeTypeIds)),
      "graph-session:has-any-orphan",
    );
  }

  /** Does the resident graph have any cycle under this edge-type
   *  filter? (empty ⇒ unfiltered.) */
  hasAnyCycle(hiddenEdgeTypeIds: Int32Array): Promise<boolean> {
    return waitForPromise(
      this.#loaded.then(() => this.#engine.hasAnyCycle(hiddenEdgeTypeIds)),
      "graph-session:has-any-cycle",
    );
  }

  /**
   * Elementary cycles as `number[][]` (node indices). Runs once in Rust
   * on the resident graph.
   *
   * `nodeRemap` is the JS contraction map (visible→self, hidden→owner,
   * unmappable→-1). When non-empty Rust enumerates on the *contracted*
   * CSR — the returned cycles are already in bundled form. When empty
   * Rust returns raw cycles and the JS pass
   * (`bundleRawCyclesWithGroups`) does the contraction. The non-empty
   * path is what saves do-not-commit-shaped graphs where intra-package
   * file cycles otherwise dominate.
   *
   * Enumeration is unbounded (exponential worst case); the call lives
   * in the worker and the main thread ignores stale results via
   * `getPromiseState`.
   */
  rawCycles(hiddenEdgeTypeIds: Int32Array, nodeRemap: Int32Array): Promise<number[][]> {
    return waitForPromise(
      this.#loaded
        .then(() => this.#engine.rawCycles(hiddenEdgeTypeIds, nodeRemap))
        .then((flat) => {
          const cycles: number[][] = [];

          for (let i = 0; i < flat.length; ) {
            const len = flat[i++]!;

            cycles.push(Array.from(flat.subarray(i, i + len)));
            i += len;
          }

          return cycles;
        }),
      "graph-session:raw-cycles",
    );
  }

  /** Terminate the worker and free the resident WASM session. */
  dispose(): void {
    // Best-effort WASM free; terminate() is what actually reclaims it if
    // the worker is mid-call (synchronous WASM can't service this).
    void this.#engine.dispose().catch(() => {});
    this.#worker.terminate();
  }
}
