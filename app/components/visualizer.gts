import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { action } from "@ember/object";
import { service } from "@ember/service";
import { htmlSafe, type SafeString } from "@ember/template";

import * as Comlink from "comlink";
import { modifier } from "ember-modifier";
import Flatbush from "flatbush";

import { Camera } from "#lib/camera";
import { communityColor } from "#lib/colors";
import { buildContraction } from "#lib/contract";
import {
  bundleAlreadyContractedCycles,
  bundleRawCyclesWithGroups,
  MAX_CYCLES,
} from "#lib/cycle";
import { convexHull, inflate, triangulateFan } from "#lib/hull";
import { packArrows, packEdges, packNodes } from "#lib/pack";
import { RenderProxy } from "#lib/render-proxy";

import Controls from "./controls.gts";
import CyclesPanel from "./cycles-panel.gts";
import Hud from "./hud.gts";
import InfoPanel from "./info-panel.gts";
import OrphansPanel from "./orphans-panel.gts";

import type { RenderPackEngine } from "#lib/render-pack.worker";
import type ViewStateService from "#services/view-state";
import type VisualizerService from "#services/visualizer";
import type { ProcessedScene } from "#services/visualizer";

/**
 * Owns the canvas, the WebGL renderer, and the input-event/picking pipeline.
 *
 * Carries no application state of its own: counts, communities, and the
 * resolved positions buffer all come from the `visualizer` service. The
 * component just watches the service in its rAF loop and repacks/redraws
 * when the resolved scene appears or the URL-backed view state changes.
 * Hover state is the only thing that lives here — it's transient mouse
 * UI, not URL-worthy.
 */
/** Stable empty filter — the canvas cycle rings show every cycle
 *  regardless of edge-type filters, so this keeps one service cache
 *  key for the unfiltered raw-cycle enumeration. */
const NO_HIDDEN = new Int32Array(0);

export default class Visualizer extends Component {
  @service declare visualizer: VisualizerService;
  @service declare viewState: ViewStateService;

  // `renderer` is a thin proxy that forwards to the render worker (which
  // owns the OffscreenCanvas, GL, and the draw loop). The method shape
  // matches the old in-process `Renderer` so `repack*` is unchanged.
  private renderer: RenderProxy | null = null;
  #renderWorker: Worker | null = null;
  #workerSelected = false;
  // Camera owns d3-zoom on the DOM canvas (main-thread input). Its
  // transform is pushed into the renderer via `setCamera` so the
  // renderer itself stays input-/DOM-free (worker-ready).
  private camera: Camera | null = null;

  private nodeInstanceBuf: Float32Array = new Float32Array(0);
  private edgeBuf: Float32Array = new Float32Array(0);
  private arrowBuf: Float32Array = new Float32Array(0);
  private cycleBuf: Float32Array = new Float32Array(0);
  /** Per-node 1/0 mask: 1 = node is on the highlighted cycle. */
  private cycleMask: Uint8Array | null = null;
  /**
   * Per-node 1/0 mask: 1 = node should render dimmed. Built when a node is
   * selected; the selected node, its direct outgoing targets (from the
   * input JSON's `edges` list), and any cycle members are left un-dimmed.
   * `null` while nothing is selected.
   */
  private dimMask: Uint8Array | null = null;
  private hullBuf: Float32Array = new Float32Array(0);
  private hullVerts = 0;

  private picker: Flatbush | null = null;
  private pickerDirty = true;

  /**
   * Effective hover state used by `repackNodes`. Resolved each frame from
   * `canvasHoveredIdx` (mouse over the canvas) and `externalHoverId` on
   * the visualizer service (info-panel row hover, etc.) — external wins
   * when set so panel-row hover takes precedence over a stale canvas
   * hover sitting underneath the panel.
   */
  private hoveredIdx = -1;
  private canvasHoveredIdx = -1;
  private lastExternalHoverId: string | null = null;
  private dirty = true;
  private rafHandle: number | null = null;
  private resizeHandler = (): void => this.handleResize();
  private cleanups: Array<() => void> = [];

  // Fingerprints so the rAF loop knows when something it cares about
  // changed. The scene comparison handles "graph swapped or first
  // resolved"; the rest pick up URL toggles.
  private lastResolved: ProcessedScene | null = null;
  private lastShowEdges = true;
  private lastShowHulls = false;
  private lastShowArrows = true;
  private lastHiddenKey = "";
  private lastHiddenNodeKey = "";
  private lastHiddenNodeIdsKey = "";
  private lastGlobKey = "";
  private lastCollapsedKey = "";
  private lastSelectedId: string | null = null;
  private lastFocusTs = 0;

  /**
   * Cached "hidden by node type" mask, keyed on `lastHiddenNodeKey`. `null`
   * means no node types are hidden — pack and pick skip the mask read in
   * that case.
   */
  private hideNodeMask: Uint8Array | null = null;

  /**
   * Per-node display radius adjusted for absorbed hidden neighbors.
   * When a hidden node H is pointed to by visible node V, V's area grows
   * by H's area (so the hidden mass appears "shoved inside"). `null`
   * means no node types are hidden — callers fall back to `scene.radii`.
   */
  private effectiveRadii: Float32Array | null = null;

  /**
   * Per-node remap used to contract edges through hidden nodes. Visible
   * nodes map to themselves; hidden nodes map to their nearest visible
   * predecessor (propagated through chains of hidden nodes), or `-1` if
   * unreachable from any visible node. `null` when nothing is hidden.
   */
  private nodeRemap: Int32Array | null = null;

  // Whole-graph elementary-cycle enumeration runs once in the resident
  // Rust session (service-memoized by graph). `#rawCycles` holds that
  // resolved list; `#rawPromise` is the identity we attached to (a new
  // graph → new promise → re-fetch). The cheap contraction/bundling
  // through the collapse remap stays here and is memoized by graph +
  // remap, NOT selection, so a click only re-filters the cached array.
  #rawPromise: Promise<number[][]> | null = null;
  #rawCycles: number[][] | null = null;
  #allCycles: number[][] | null = null;
  #allCyclesGraph: ProcessedScene["graph"] | null = null;
  #allCyclesRemap: Int32Array | null = null;

  // Per-scene edge incidence (CSR by raw node index): `#incEdges` lists
  // every edge index touching node v in `[#incIdx[v], #incIdx[v+1])`.
  // Lets the "edges hidden, node selected" repack iterate the selected
  // node's edges only — O(degree) — instead of scanning all graph edges
  // on every click. Memoized by graph identity.
  #incGraph: ProcessedScene["graph"] | null = null;
  #incIdx: Int32Array | null = null;
  #incEdges: Int32Array | null = null;

  // Off-main-thread vertex packing. The worker owns a copy of the scene
  // arrays; selection/filter changes get a transferable buffer back so
  // the (potentially large) edge/arrow pack never blocks the main
  // thread. Only used when `nodeRemap === null` (no node contraction) —
  // the contracted case stays on the synchronous main-thread path.
  // Sequence counters discard out-of-order async results when the
  // selection changes faster than the worker replies.
  #packEngine: Comlink.Remote<RenderPackEngine> | null = null;
  #packWorker: Worker | null = null;
  #packSceneGraph: ProcessedScene["graph"] | null = null;
  #packEdgeSeq = 0;
  #packArrowSeq = 0;

  /**
   * Median edge length in world units (sampled, ≤2000 edges, so it's
   * O(1)-ish per scene). Median — not mean — so a handful of very long
   * inter-cluster edges don't keep the LOD cull from kicking in when the
   * vast majority of edges are tiny. 0 when there are no edges.
   */
  private medianEdgeLength(scene: ProcessedScene): number {
    const ef = scene.graph.edgesFlat;
    const pos = scene.positions;
    const E = ef.length / 2;

    if (E === 0) return 0;

    const stride = Math.max(1, Math.floor(E / 2000));
    const lens: number[] = [];

    for (let i = 0; i < E; i += stride) {
      const a = ef[2 * i]!;
      const b = ef[2 * i + 1]!;
      const dx = pos[2 * a]! - pos[2 * b]!;
      const dy = pos[2 * a + 1]! - pos[2 * b + 1]!;

      lens.push(Math.hypot(dx, dy));
    }

    lens.sort((p, q) => p - q);

    return lens[lens.length >> 1] ?? 0;
  }

  /** Incident edge-index list for `node`, or null when contraction is
   *  active (the fast path is only valid with `nodeRemap === null`). */
  private incidentEdges(scene: ProcessedScene, node: number): Int32Array | null {
    if (this.nodeRemap !== null || node < 0) return null;

    if (this.#incGraph !== scene.graph || this.#incIdx === null) {
      const ef = scene.graph.edgesFlat;
      const E = ef.length / 2;
      const N = scene.communities.length;
      const idx = new Int32Array(N + 1);

      for (let i = 0; i < E; i++) {
        idx[ef[2 * i]! + 1]!++;
        idx[ef[2 * i + 1]! + 1]!++;
      }

      for (let i = 0; i < N; i++) idx[i + 1]! += idx[i]!;

      const edges = new Int32Array(2 * E);
      const filled = new Int32Array(N);

      for (let i = 0; i < E; i++) {
        const a = ef[2 * i]!;
        const b = ef[2 * i + 1]!;

        edges[idx[a]! + filled[a]!] = i;
        filled[a]!++;
        edges[idx[b]! + filled[b]!] = i;
        filled[b]!++;
      }

      this.#incGraph = scene.graph;
      this.#incIdx = idx;
      this.#incEdges = edges;
    }

    return this.#incEdges!.subarray(this.#incIdx[node], this.#incIdx[node + 1]);
  }

  // ember-modifier auto-tracks reads inside the function body, so any tracked
  // value read here would tear down + re-run the renderer on every change.
  // Keep this body free of viewState/visualizer reads — the rAF loop and
  // `reactToScene` handle reactive sync against the renderer.
  setupCanvas = modifier((canvas: HTMLCanvasElement) => {
    // Hand the canvas to the render worker; GL + the draw loop run there.
    const worker = new Worker(new URL("../lib/render.worker.ts", import.meta.url), {
      type: "module",
    });
    const off = canvas.transferControlToOffscreen();
    const dpr = window.devicePixelRatio || 1;

    this.#renderWorker = worker;
    this.renderer = new RenderProxy(worker);
    this.renderer.init(off, window.innerWidth, window.innerHeight, dpr);
    // Camera stays on the main thread (d3-zoom needs the DOM canvas);
    // its transform is streamed to the worker via `renderer.setCamera`.
    this.camera = new Camera(canvas);
    this.handleResize();
    window.addEventListener("resize", this.resizeHandler);

    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("contextmenu", this.onContextMenu);
    canvas.addEventListener("dblclick", this.onDblClick);
    this.cleanups.push(() => {
      canvas.removeEventListener("pointermove", this.onPointerMove);
      canvas.removeEventListener("pointerdown", this.onPointerDown);
      canvas.removeEventListener("contextmenu", this.onContextMenu);
      canvas.removeEventListener("dblclick", this.onDblClick);
    });

    this.#packWorker = new Worker(new URL("../lib/render-pack.worker.ts", import.meta.url), {
      type: "module",
    });
    this.#packEngine = Comlink.wrap<RenderPackEngine>(this.#packWorker);
    this.cleanups.push(() => {
      this.#packWorker?.terminate();
      this.#packWorker = null;
      this.#packEngine = null;
    });

    this.camera.onChange(() => {
      if (this.camera && this.renderer) {
        this.renderer.setCamera(this.camera.x, this.camera.y, this.camera.zoom);
      }

      this.dirty = true;
    });

    // Start the rAF loop via requestAnimationFrame rather than calling
    // `loop()` directly. The loop body reads tracked state (scene, viewState
    // getters); invoking it synchronously inside the modifier would tie the
    // modifier's lifetime to those tracked tags and tear the renderer down
    // on every URL change.
    this.rafHandle = requestAnimationFrame(this.loop);

    return () => this.teardown();
  });

  /** Resolve the URL-encoded selected id to a scene index, or -1. */
  private get selectedIdx(): number {
    const scene = this.visualizer.scene;
    const id = this.viewState.selectedId;

    if (!scene || id === null) return -1;

    const idx = scene.graph.idToIndex.get(id);

    return idx ?? -1;
  }

  /** Integer percent (0–100) of the in-flight layout simulation. */
  get layoutProgressPercent(): number {
    const p = this.visualizer.layoutProgress;

    if (p === null || p.total <= 0) return 0;

    return Math.min(100, Math.floor((p.tick / p.total) * 100));
  }

  /**
   * Inline style for the progress bar's fill width. Wrapped in
   * `htmlSafe` so Glimmer doesn't warn about XSS-bound style attrs — the
   * value is a single integer percentage so there's no escape concern.
   */
  get layoutProgressBarStyle(): SafeString {
    return htmlSafe(`width: ${this.layoutProgressPercent}%`);
  }

  /**
   * Per-frame: detect transitions (new scene, view-state changes) and do
   * the side-effecty repack/upload work. Reads service getters directly,
   * primitive-compares against last-seen values.
   */
  private reactToScene(scene: ProcessedScene): void {
    const vs = this.viewState;
    const showEdges = vs.showEdges;
    const showHulls = vs.showHulls;
    const showArrows = vs.showArrows;
    const hiddenKey = serializeHidden(vs.hiddenEdgeTypes);
    const hiddenNodeKey = serializeHidden(vs.hiddenNodeTypes);
    const hiddenNodeIdsKey = serializeStringSet(vs.hiddenNodeIds);
    const globKey = `${vs.includeGlobs.join("|")}::${vs.excludeGlobs.join("|")}`;
    const collapsedKey = serializeStringSet(vs.collapsedIds);
    const selectedId = vs.selectedId;

    if (showEdges !== this.lastShowEdges) {
      this.lastShowEdges = showEdges;
      // Both edges and arrows need to repack: turning edges off only leaves
      // the selected node's edges in the buffer, and turning them back on
      // restores the full set.
      this.repackEdges(scene);
      this.repackArrows(scene);
      this.dirty = true;
    }

    if (showHulls !== this.lastShowHulls) {
      this.lastShowHulls = showHulls;
      this.renderer?.setShowHulls(showHulls);
      if (showHulls) this.repackHulls(scene);
      this.dirty = true;
    }

    if (showArrows !== this.lastShowArrows) {
      this.lastShowArrows = showArrows;
      this.renderer?.setShowArrows(showArrows);
      if (showArrows) this.repackArrows(scene);
      this.dirty = true;
    }

    if (hiddenKey !== this.lastHiddenKey) {
      this.lastHiddenKey = hiddenKey;
      this.repackEdges(scene);
      this.repackArrows(scene);
      this.dirty = true;
    }

    if (
      hiddenNodeKey !== this.lastHiddenNodeKey ||
      collapsedKey !== this.lastCollapsedKey ||
      hiddenNodeIdsKey !== this.lastHiddenNodeIdsKey ||
      globKey !== this.lastGlobKey
    ) {
      this.lastHiddenNodeKey = hiddenNodeKey;
      this.lastCollapsedKey = collapsedKey;
      this.lastHiddenNodeIdsKey = hiddenNodeIdsKey;
      this.lastGlobKey = globKey;
      this.rebuildHideNodeMask(scene);
      // Cycle depends on the contracted graph — recompute before nodes so
      // the red ring lands on the current cycle members.
      this.repackCycle(scene);
      this.repackNodes(scene);
      this.repackEdges(scene);
      this.repackArrows(scene);
      this.dirty = true;
    }

    if (selectedId !== this.lastSelectedId) {
      this.lastSelectedId = selectedId;
      // Cycle must come first — `repackNodes` reads `cycleMask` so the
      // red outline shows up the same frame the cycle edges do.
      this.repackCycle(scene);
      this.repackNodes(scene);

      // When the global edges toggle is off we only show the edges touching
      // the selected node, so changing the selection swaps the visible set.
      // Same idea for arrows.
      if (!showEdges) {
        this.repackEdges(scene);
        this.repackArrows(scene);
      }

      this.dirty = true;
    }
  }

  /**
   * Pick up a pending "focus on this id" request from the visualizer
   * service (set by the search component) and animate the camera to the
   * node if it's outside the current viewport. No-op when the node is
   * already visible — don't yank the user around when they didn't need it.
   */
  private maybeHandleFocus(scene: ProcessedScene): void {
    const req = this.visualizer.pendingFocus;

    if (req === null) return;
    if (req.ts === this.lastFocusTs) return;
    this.lastFocusTs = req.ts;
    this.visualizer.pendingFocus = null;

    const idx = scene.graph.idToIndex.get(req.id);

    if (idx === undefined || !this.renderer) return;

    const x = scene.positions[2 * idx]!;
    const y = scene.positions[2 * idx + 1]!;
    const cam = this.camera;

    if (!cam || cam.worldPointInView(x, y)) return;
    cam.animateTo(x, y, cam.zoom);
  }

  private repackCycle(scene: ProcessedScene): void {
    if (!this.renderer) return;

    const selected = this.selectedIdx;

    if (selected < 0) {
      this.cycleMask = null;
      this.dimMask = null;
      this.renderer.uploadCycleEdges(new Float32Array(0), 0);

      return;
    }

    const N = scene.communities.length;

    // Elementary cycles come from the resident Rust session (the
    // exponential enumeration, run once, service-memoized per remap +
    // edge-type filter). Pass the current node remap so the renderer's
    // bundled-cycle list matches what the cycles panel and info panel
    // see — without that, the canvas runs on the raw (file-level) CSR,
    // and on graphs whose raw cycles all live inside one package every
    // cycle bundles to a self-loop and disappears: the red rings + red
    // edges silently stop being drawn even though there are dozens of
    // real package-level cycles through the selected node. Fetch is
    // async; attach once per (graph, remap), store the resolved list,
    // and ask the loop to repack when it lands.
    const rawPromise = this.visualizer.cycleRaw(NO_HIDDEN, this.nodeRemap, MAX_CYCLES);

    if (rawPromise !== this.#rawPromise) {
      this.#rawPromise = rawPromise;
      this.#rawCycles = null;
      this.#allCycles = null;

      rawPromise
        ?.then((rc) => {
          if (this.#rawPromise === rawPromise) {
            this.#rawCycles = rc;
            this.#allCycles = null;
            this.dirty = true;
          }
        })
        .catch(() => {});
    }

    if (this.#rawCycles === null) {
      this.cycleMask = null;
      this.dimMask = null;
      this.renderer.uploadCycleEdges(new Float32Array(0), 0);

      return;
    }

    // When Rust enumerated on the contracted CSR (`nodeRemap` non-null)
    // the returned cycles are already bundled — `bundleAlreadyContracted-
    // Cycles` just dedupes by visual key. When there's no contraction
    // the legacy bundle pass (raw → bundled with groups) handles it.
    // Memoized by graph + remap — not selection — so a click only
    // re-filters the cached array.
    if (
      this.#allCycles === null ||
      this.#allCyclesGraph !== scene.graph ||
      this.#allCyclesRemap !== this.nodeRemap
    ) {
      this.#allCycles = (
        this.nodeRemap
          ? bundleAlreadyContractedCycles(scene.graph, this.nodeRemap, this.#rawCycles)
          : bundleRawCyclesWithGroups(this.#rawCycles, null)
      ).map((b) => b.bundled);
      this.#allCyclesGraph = scene.graph;
      this.#allCyclesRemap = this.nodeRemap;
    }

    const cycles = this.#allCycles.filter((c) => c.includes(selected));
    let cycleMask: Uint8Array | null = null;

    if (cycles.length > 0) {
      cycleMask = new Uint8Array(N);

      // Total edge segments across every highlighted cycle. Each cycle of
      // length L contributes L edges (L-1 in-order + 1 closing), and each
      // edge is 2 vertices × 6 floats.
      let totalEdges = 0;

      for (const cycle of cycles) totalEdges += cycle.length;

      const need = totalEdges * 12;

      if (this.cycleBuf.length < need) this.cycleBuf = new Float32Array(need);

      const buf = this.cycleBuf;
      // Bright red so it pops over the dim community-colored edges.
      const R = 1.0;
      const G = 0.25;
      const B = 0.3;
      const A = 0.95;
      let k = 0;

      const emit = (a: number, b: number): void => {
        buf[k++] = scene.positions[2 * a]!;
        buf[k++] = scene.positions[2 * a + 1]!;
        buf[k++] = R;
        buf[k++] = G;
        buf[k++] = B;
        buf[k++] = A;
        buf[k++] = scene.positions[2 * b]!;
        buf[k++] = scene.positions[2 * b + 1]!;
        buf[k++] = R;
        buf[k++] = G;
        buf[k++] = B;
        buf[k++] = A;
      };

      // Dedupe edges across cycles — overlapping segments are drawn once
      // instead of stacked, otherwise the line alpha compounds and the
      // shared edges read brighter than the others.
      const seenEdges = new Set<number>();
      let drawnEdges = 0;

      for (const cycle of cycles) {
        for (const idx of cycle) cycleMask[idx] = 1;

        for (let i = 0; i < cycle.length; i++) {
          const a = cycle[i]!;
          const b = cycle[(i + 1) % cycle.length]!;
          const key = a * N + b;

          if (seenEdges.has(key)) continue;
          seenEdges.add(key);
          emit(a, b);
          drawnEdges++;
        }
      }

      this.renderer.uploadCycleEdges(buf, drawnEdges * 2);
    } else {
      this.renderer.uploadCycleEdges(new Float32Array(0), 0);
    }

    this.cycleMask = cycleMask;

    // Dim everything that isn't the selected node, one of its direct
    // outgoing targets (per the input JSON's `edges` list), or a cycle
    // member. `edgesFlat` stores pre-remap node indices, so targets pass
    // through `nodeRemap` to land on the visible representative when node
    // contraction is active.
    const dim = new Uint8Array(N).fill(1);

    dim[selected] = 0;

    const edges = scene.graph.edgesFlat;
    const remap = this.nodeRemap;
    const incident = this.incidentEdges(scene, selected);

    if (incident !== null) {
      // Fast path (no contraction): only the selected node's incident
      // edges, O(degree) instead of scanning the whole edge list.
      for (let t = 0; t < incident.length; t++) {
        const i = incident[t]!;

        if (edges[2 * i]! === selected) dim[edges[2 * i + 1]!] = 0;
      }
    } else {
      for (let k = 0; k < edges.length; k += 2) {
        if (edges[k] !== selected) continue;

        let b = edges[k + 1]!;

        if (remap !== null) {
          b = remap[b]!;
          if (b < 0) continue;
        }

        dim[b] = 0;
      }
    }

    if (cycleMask !== null) {
      for (let i = 0; i < N; i++) {
        if (cycleMask[i] === 1) dim[i] = 0;
      }
    }

    this.dimMask = dim;
  }

  private rebuildHideNodeMask(scene: ProcessedScene): void {
    const c = buildContraction(
      scene.graph,
      scene.radii,
      this.viewState.hiddenNodeTypes,
      this.viewState.collapsedIds,
      this.viewState.effectiveHiddenNodeIds(scene.graph),
    );

    if (c === null) {
      this.hideNodeMask = null;
      this.effectiveRadii = null;
      this.nodeRemap = null;
    } else {
      this.hideNodeMask = c.hideMask;
      this.effectiveRadii = c.effectiveRadii;
      this.nodeRemap = c.nodeRemap;
    }

    this.pickerDirty = true;
  }

  private repackNodes(scene: ProcessedScene): void {
    if (!this.renderer) return;
    this.nodeInstanceBuf = packNodes(
      scene.positions,
      this.effectiveRadii ?? scene.radii,
      scene.communities,
      this.selectedIdx,
      this.hoveredIdx,
      this.dimMask,
      this.hideNodeMask,
      this.cycleMask,
      this.nodeInstanceBuf,
    );
    this.renderer.uploadNodeInstances(this.nodeInstanceBuf, scene.communities.length);
  }

  /**
   * When the global "edges" toggle is off, we still reveal the edges that
   * touch the selected node (so the user can see what flows in/out without
   * needing to flip the toggle back on). Returns `-1` when no restriction
   * applies — pack everything matching the type filter.
   */
  private edgeRestriction(): number {
    return this.viewState.showEdges ? -1 : this.selectedIdx;
  }

  private repackEdges(scene: ProcessedScene): void {
    if (!this.renderer) return;

    const restrict = this.edgeRestriction();

    if (!this.viewState.showEdges && restrict < 0) {
      this.renderer.uploadLines(new Float32Array(0), 0);

      return;
    }

    // Off-thread when there's no contraction: the worker owns the scene
    // copy and the incidence index, returns a transferable buffer.
    if (this.#packEngine && this.nodeRemap === null && this.#packSceneGraph === scene.graph) {
      const seq = ++this.#packEdgeSeq;
      const hidden = Array.from(this.viewState.hiddenEdgeTypes);

      void this.#packEngine.packEdges(hidden, restrict).then((res) => {
        if (seq !== this.#packEdgeSeq || !this.renderer) return;

        const f = new Float32Array(res.buffer);

        this.edgeBuf = f;
        this.renderer.uploadLines(f, res.vertexCount);
        this.dirty = true;
      });

      return;
    }

    const { buffer, vertexCount } = packEdges(
      scene.graph.edgesFlat,
      scene.positions,
      scene.communities,
      this.edgeBuf,
      scene.graph.edgeTypeIds,
      this.viewState.hiddenEdgeTypes,
      this.nodeRemap,
      restrict,
      restrict >= 0 ? this.incidentEdges(scene, restrict) : null,
    );

    this.edgeBuf = buffer;
    this.renderer.uploadLines(this.edgeBuf, vertexCount);
  }

  private repackArrows(scene: ProcessedScene): void {
    if (!this.renderer) return;

    if (!this.viewState.showArrows) {
      this.renderer.uploadArrows(new Float32Array(0), 0);

      return;
    }

    const restrict = this.edgeRestriction();

    if (!this.viewState.showEdges && restrict < 0) {
      this.renderer.uploadArrows(new Float32Array(0), 0);

      return;
    }

    if (this.#packEngine && this.nodeRemap === null && this.#packSceneGraph === scene.graph) {
      const seq = ++this.#packArrowSeq;
      const hidden = Array.from(this.viewState.hiddenEdgeTypes);

      void this.#packEngine.packArrows(hidden, restrict).then((res) => {
        if (seq !== this.#packArrowSeq || !this.renderer) return;

        const f = new Float32Array(res.buffer);

        this.arrowBuf = f;
        this.renderer.uploadArrows(f, res.count);
        this.dirty = true;
      });

      return;
    }

    const { buffer, count } = packArrows(
      scene.graph.edgesFlat,
      scene.positions,
      this.effectiveRadii ?? scene.radii,
      scene.communities,
      this.arrowBuf,
      scene.graph.edgeTypeIds,
      this.viewState.hiddenEdgeTypes,
      this.nodeRemap,
      restrict,
      restrict >= 0 ? this.incidentEdges(scene, restrict) : null,
    );

    this.arrowBuf = buffer;
    this.renderer.uploadArrows(this.arrowBuf, count);
  }

  private repackHulls(scene: ProcessedScene): void {
    if (!this.renderer) return;

    const buckets = new Map<number, [number, number][]>();

    for (let i = 0; i < scene.communities.length; i++) {
      const c = scene.communities[i]!;
      const arr = buckets.get(c);
      const point: [number, number] = [scene.positions[2 * i]!, scene.positions[2 * i + 1]!];

      if (arr) arr.push(point);
      else buckets.set(c, [point]);
    }

    const chunks: Float32Array[] = [];
    let total = 0;

    for (const [c, pts] of buckets) {
      if (pts.length < 3) continue;

      const hull = convexHull(pts);

      if (!hull) continue;

      const inflated = inflate(hull, 8);
      const tris = triangulateFan(inflated);

      if (tris.length === 0) continue;

      const [r, g, b] = communityColor(c);
      const a = 0.06;
      const verts = tris.length / 2;
      const out = new Float32Array(verts * 6);

      for (let i = 0; i < verts; i++) {
        out[i * 6] = tris[i * 2]!;
        out[i * 6 + 1] = tris[i * 2 + 1]!;
        out[i * 6 + 2] = r;
        out[i * 6 + 3] = g;
        out[i * 6 + 4] = b;
        out[i * 6 + 5] = a;
      }

      chunks.push(out);
      total += verts;
    }

    let offset = 0;
    const combined = new Float32Array(total * 6);

    for (const c of chunks) {
      combined.set(c, offset);
      offset += c.length;
    }

    this.hullBuf = combined;
    this.hullVerts = total;
    this.renderer.uploadHulls(this.hullBuf, this.hullVerts);
  }

  private fitInitialView(scene: ProcessedScene): void {
    if (!this.renderer) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < scene.positions.length; i += 2) {
      const x = scene.positions[i]!;
      const y = scene.positions[i + 1]!;

      if (!isFinite(x) || !isFinite(y)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }

    if (!isFinite(minX) || !this.camera) return;
    this.camera.fit(minX, minY, maxX, maxY);
    this.renderer?.setCamera(this.camera.x, this.camera.y, this.camera.zoom);
  }

  private rebuildPicker(scene: ProcessedScene): void {
    const N = scene.communities.length;

    if (N === 0) {
      this.picker = null;
      this.pickerDirty = false;

      return;
    }

    const radii = this.effectiveRadii ?? scene.radii;
    const idx = new Flatbush(N);

    for (let i = 0; i < N; i++) {
      const x = scene.positions[2 * i]!;
      const y = scene.positions[2 * i + 1]!;
      const r = radii[i]!;

      idx.add(x - r, y - r, x + r, y + r);
    }

    idx.finish();
    this.picker = idx;
    this.pickerDirty = false;
  }

  private pickAt(sx: number, sy: number): number {
    const scene = this.visualizer.scene;

    if (!this.renderer || !scene || !this.camera) return -1;
    if (this.pickerDirty) this.rebuildPicker(scene);
    if (!this.picker) return -1;

    const dpr = window.devicePixelRatio || 1;
    const [wx, wy] = this.camera.screenToWorld(sx * dpr, sy * dpr);
    // Hit radius in world coords corresponds to the rendered screen-px floor
    // (max(4, r*zoom)). At low zoom, the world-space hit area grows so tiny
    // dots stay clickable — so we search a box of that minimum radius around
    // the click, then refine.
    const zoom = this.camera.zoom || 1;
    const minHitWorld = 4 / zoom;
    const candidates = this.picker.search(
      wx - minHitWorld,
      wy - minHitWorld,
      wx + minHitWorld,
      wy + minHitWorld,
    );
    let best = -1;
    let bestDist = Infinity;

    const radii = this.effectiveRadii ?? scene.radii;

    for (const c of candidates) {
      if (this.hideNodeMask !== null && this.hideNodeMask[c] === 1) continue;

      const x = scene.positions[2 * c]!;
      const y = scene.positions[2 * c + 1]!;
      const r = Math.max(radii[c]!, minHitWorld);
      const dx = wx - x;
      const dy = wy - y;
      const d2 = dx * dx + dy * dy;

      if (d2 <= r * r && d2 < bestDist) {
        bestDist = d2;
        best = c;
      }
    }

    return best;
  }

  onPointerMove = (ev: PointerEvent): void => {
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const idx = this.pickAt(sx, sy);

    if (idx !== this.canvasHoveredIdx) {
      this.canvasHoveredIdx = idx;
      // Don't repack here; let `maybeReactToHover` in the rAF loop
      // merge canvas + external hover sources and decide.
      this.dirty = true;
    }
  };

  /**
   * Per-frame: combine canvas hover and external (panel) hover into the
   * single `hoveredIdx` the renderer uses, repacking nodes if it changed.
   */
  private maybeReactToHover(scene: ProcessedScene): void {
    const externalId = this.visualizer.externalHoverId;
    let resolved = this.canvasHoveredIdx;

    if (externalId !== null) {
      const idx = scene.graph.idToIndex.get(externalId);

      if (idx !== undefined) resolved = idx;
    }

    if (resolved === this.hoveredIdx && externalId === this.lastExternalHoverId) return;
    this.hoveredIdx = resolved;
    this.lastExternalHoverId = externalId;
    this.repackNodes(scene);
    this.dirty = true;
  }

  onPointerDown = (ev: PointerEvent): void => {
    if (ev.button !== 0) return;

    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const idx = this.pickAt(sx, sy);

    // Only act on a node hit. Empty-space left-clicks pass through so
    // d3-zoom can pan; clearing the selection is right-click or the close
    // button.
    if (idx < 0) return;
    if (idx === this.selectedIdx) return;

    const scene = this.visualizer.scene;

    if (scene) this.viewState.selectedId = scene.graph.ids[idx]!;
  };

  onContextMenu = (ev: MouseEvent): void => {
    ev.preventDefault();
    if (this.selectedIdx === -1) return;
    this.viewState.selectedId = null;
  };

  onDblClick = (ev: MouseEvent): void => {
    ev.preventDefault();

    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const idx = this.pickAt(sx, sy);

    if (idx < 0) return;

    const scene = this.visualizer.scene;

    if (!scene) return;
    this.viewState.toggleCollapsed(scene.graph.ids[idx]!);
  };

  @action
  resetView(): void {
    const scene = this.visualizer.scene;

    if (scene) this.fitInitialView(scene);
    this.dirty = true;
  }

  private handleResize(): void {
    if (!this.renderer) return;

    const dpr = window.devicePixelRatio || 1;

    this.renderer.resize(window.innerWidth, window.innerHeight, dpr);
    // Renderer no longer owns the camera, so resize it here and push the
    // (possibly clamped) transform back into the renderer.
    this.camera?.resize(Math.floor(window.innerWidth * dpr), Math.floor(window.innerHeight * dpr));

    if (this.camera) {
      this.renderer.setCamera(this.camera.x, this.camera.y, this.camera.zoom);
    }

    this.dirty = true;
  }

  private loop = (): void => {
    const scene = this.visualizer.scene;

    if (scene && scene !== this.lastResolved) {
      this.lastResolved = scene;
      this.pickerDirty = true;
      // Rebuild the hide mask first — both repack calls below read it.
      this.rebuildHideNodeMask(scene);
      this.lastHiddenNodeKey = serializeHidden(this.viewState.hiddenNodeTypes);
      this.lastCollapsedKey = serializeStringSet(this.viewState.collapsedIds);
      this.lastHiddenNodeIdsKey = serializeStringSet(this.viewState.hiddenNodeIds);
      this.lastGlobKey = `${this.viewState.includeGlobs.join("|")}::${this.viewState.excludeGlobs.join("|")}`;
      // Sync the renderer's toggles with the URL-backed state before the
      // first draw so an `arrows=0` URL doesn't briefly render arrows.
      // `showEdges` is no longer a renderer-side flag — the visualizer
      // controls the line buffer's contents (with selection-only reveal
      // when the toggle is off) and the renderer just draws whatever's
      // there.
      this.lastShowEdges = this.viewState.showEdges;
      this.lastShowHulls = this.viewState.showHulls;
      this.lastShowArrows = this.viewState.showArrows;
      this.renderer?.setShowHulls(this.lastShowHulls);
      this.renderer?.setShowArrows(this.lastShowArrows);
      // Hand the worker its own copy of the scene arrays (structured
      // clone — the main thread keeps the originals for picking/dimming).
      // Must run before the repacks below so a same-iteration async pack
      // sees the scene.
      this.#packSceneGraph = scene.graph;
      void this.#packEngine?.setScene(
        scene.positions,
        scene.graph.edgesFlat,
        scene.communities,
        scene.graph.edgeTypeIds,
        this.effectiveRadii ?? scene.radii,
      );
      this.renderer?.setEdgeLod(this.medianEdgeLength(scene));
      this.repackCycle(scene);
      this.repackNodes(scene);
      this.repackEdges(scene);
      this.repackArrows(scene);
      if (this.viewState.showHulls) this.repackHulls(scene);
      this.fitInitialView(scene);
      this.dirty = true;
    }

    if (scene) {
      this.reactToScene(scene);
      this.maybeReactToHover(scene);
      this.maybeHandleFocus(scene);

      // The render worker owns the draw loop and animates the selection
      // halo itself (off `performance.now()`); just tell it whether a
      // node is selected so it keeps drawing every frame for the halo.
      const selNow = this.viewState.selectedId !== null;

      if (selNow !== this.#workerSelected) {
        this.#workerSelected = selNow;
        this.renderer?.setSelected(selNow);
      }

      if (this.dirty && this.renderer) {
        this.renderer.markDirty();
        this.dirty = false;
      }
    } else if (this.dirty && this.renderer) {
      // Clear the canvas while the pipeline is still working so we don't
      // leave a previous scene visible behind the loading overlay.
      this.renderer.markDirty();
      this.dirty = false;
    }

    // Cadence pulse — vsync-aligned (this rAF fires at the real display
    // refresh, incl. 240Hz). The worker draws iff dirty/selected.
    this.renderer?.tick();
    this.sampleFps();

    this.rafHandle = requestAnimationFrame(this.loop);
  };

  /**
   * On-screen FPS = frames the *render worker actually drew* per second
   * (it posts a `frame` per real draw; `framesRendered` is the running
   * count). Sampled over ~500ms so the readout is steady, not jittery.
   */
  @tracked fps = 0;
  #fpsAt = 0;
  #fpsFrames = 0;

  private sampleFps(): void {
    const now = performance.now();

    if (this.#fpsAt === 0) {
      this.#fpsAt = now;
      this.#fpsFrames = this.renderer?.framesRendered ?? 0;

      return;
    }

    const elapsed = now - this.#fpsAt;

    if (elapsed >= 500) {
      const total = this.renderer?.framesRendered ?? 0;

      this.fps = Math.round(((total - this.#fpsFrames) * 1000) / elapsed);
      this.#fpsFrames = total;
      this.#fpsAt = now;
    }
  }

  private teardown(): void {
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
    window.removeEventListener("resize", this.resizeHandler);
    for (const fn of this.cleanups) fn();
    this.cleanups = [];

    this.camera?.destroy();
    this.camera = null;
    this.renderer = null;
    this.#renderWorker?.terminate();
    this.#renderWorker = null;
  }

  <template>
    <canvas class="visualizer__canvas" {{this.setupCanvas}}></canvas>
    <div class="visualizer__fps" title="Frames per second drawn by the render worker">
      {{this.fps}}
      fps
    </div>
    {{#if this.visualizer.state.isLoading}}
      <div class="visualizer__loading" role="status">
        <span class="visualizer__loading-label">Computing layout&hellip;</span>
        {{#if this.visualizer.layoutProgress}}
          <div
            class="visualizer__progress"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={{this.layoutProgressPercent}}
          >
            <div class="visualizer__progress-fill" style={{this.layoutProgressBarStyle}}></div>
          </div>
          <span class="visualizer__progress-text">
            {{this.layoutProgressPercent}}%
          </span>
        {{/if}}
      </div>
    {{/if}}
    {{#if this.visualizer.state.error}}
      <div class="visualizer__error" role="alert">
        Layout failed.
      </div>
    {{/if}}
    {{! Render persistent UI unconditionally — gating on `isReady` makes }}
    {{! these flicker out and back in while the layout worker reruns after }}
    {{! a slider change. Each child handles its own "not yet ready" state. }}
    <Controls @onResetView={{this.resetView}} />
    <CyclesPanel />
    <OrphansPanel />
    <InfoPanel />
    <Hud />
  </template>
}

function serializeHidden(set: Set<number>): string {
  if (set.size === 0) return "";

  return [...set].sort((a, b) => a - b).join(",");
}

function serializeStringSet(set: Set<string>): string {
  if (set.size === 0) return "";

  return [...set].sort().join(" ");
}
