import Component from "@glimmer/component";
import { action } from "@ember/object";
import { service } from "@ember/service";

import { modifier } from "ember-modifier";
import Flatbush from "flatbush";

import { communityColor } from "#lib/colors";
import { buildContraction } from "#lib/contract";
import { findShortestCycleThrough } from "#lib/cycle";
import { convexHull, inflate, triangulateFan } from "#lib/hull";
import { packEdges, packNodes } from "#lib/pack";
import { Renderer } from "#lib/renderer";

import Controls from "./controls.gts";
import Hud from "./hud.gts";
import InfoPanel from "./info-panel.gts";

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
export default class Visualizer extends Component {
  @service declare visualizer: VisualizerService;
  @service declare viewState: ViewStateService;

  private renderer: Renderer | null = null;

  private nodeInstanceBuf: Float32Array = new Float32Array(0);
  private edgeBuf: Float32Array = new Float32Array(0);
  private cycleBuf: Float32Array = new Float32Array(0);
  /** Per-node 1/0 mask: 1 = node is on the highlighted cycle. */
  private cycleMask: Uint8Array | null = null;
  private hullBuf: Float32Array = new Float32Array(0);
  private hullVerts = 0;

  private picker: Flatbush | null = null;
  private pickerDirty = true;

  /** Mouse hover state — transient, not URL-worthy and not tracked. */
  private hoveredIdx = -1;
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
  private lastHiddenKey = "";
  private lastHiddenNodeKey = "";
  private lastCollapsedKey = "";
  private lastSelectedId: string | null = null;

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

  // ember-modifier auto-tracks reads inside the function body, so any tracked
  // value read here would tear down + re-run the renderer on every change.
  // Keep this body free of viewState/visualizer reads — the rAF loop and
  // `reactToScene` handle reactive sync against the renderer.
  setupCanvas = modifier((canvas: HTMLCanvasElement) => {
    this.renderer = new Renderer(canvas);
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

    this.renderer.camera.onChange(() => {
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

  /**
   * Per-frame: detect transitions (new scene, view-state changes) and do
   * the side-effecty repack/upload work. Reads service getters directly,
   * primitive-compares against last-seen values.
   */
  private reactToScene(scene: ProcessedScene): void {
    const vs = this.viewState;
    const showEdges = vs.showEdges;
    const showHulls = vs.showHulls;
    const hiddenKey = serializeHidden(vs.hiddenEdgeTypes);
    const hiddenNodeKey = serializeHidden(vs.hiddenNodeTypes);
    const collapsedKey = serializeStringSet(vs.collapsedIds);
    const selectedId = vs.selectedId;

    if (showEdges !== this.lastShowEdges) {
      this.lastShowEdges = showEdges;
      this.renderer?.setShowEdges(showEdges);
      this.repackEdges(scene);
      this.dirty = true;
    }

    if (showHulls !== this.lastShowHulls) {
      this.lastShowHulls = showHulls;
      this.renderer?.setShowHulls(showHulls);
      if (showHulls) this.repackHulls(scene);
      this.dirty = true;
    }

    if (hiddenKey !== this.lastHiddenKey) {
      this.lastHiddenKey = hiddenKey;
      this.repackEdges(scene);
      this.dirty = true;
    }

    if (hiddenNodeKey !== this.lastHiddenNodeKey || collapsedKey !== this.lastCollapsedKey) {
      this.lastHiddenNodeKey = hiddenNodeKey;
      this.lastCollapsedKey = collapsedKey;
      this.rebuildHideNodeMask(scene);
      // Cycle depends on the contracted graph — recompute before nodes so
      // the red ring lands on the current cycle members.
      this.repackCycle(scene);
      this.repackNodes(scene);
      this.repackEdges(scene);
      this.dirty = true;
    }

    if (selectedId !== this.lastSelectedId) {
      this.lastSelectedId = selectedId;
      // Cycle must come first — `repackNodes` reads `cycleMask` so the
      // red outline shows up the same frame the cycle edges do.
      this.repackCycle(scene);
      this.repackNodes(scene);
      this.dirty = true;
    }
  }

  private repackCycle(scene: ProcessedScene): void {
    if (!this.renderer) return;

    const selected = this.selectedIdx;

    if (selected < 0) {
      this.cycleMask = null;
      this.renderer.uploadCycleEdges(new Float32Array(0), 0);

      return;
    }

    const cycle = findShortestCycleThrough(scene.graph, selected, this.nodeRemap);

    if (cycle === null || cycle.length < 2) {
      this.cycleMask = null;
      this.renderer.uploadCycleEdges(new Float32Array(0), 0);

      return;
    }

    const N = scene.communities.length;
    const mask = new Uint8Array(N);

    for (const i of cycle) mask[i] = 1;
    this.cycleMask = mask;

    // Each cycle edge: 2 vertices × 6 floats (x, y, r, g, b, a).
    const need = cycle.length * 12;

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

    for (let i = 0; i < cycle.length - 1; i++) emit(cycle[i]!, cycle[i + 1]!);
    // Closing edge: last node → first.
    emit(cycle[cycle.length - 1]!, cycle[0]!);

    this.renderer.uploadCycleEdges(buf, cycle.length * 2);
  }

  private rebuildHideNodeMask(scene: ProcessedScene): void {
    const c = buildContraction(
      scene.graph,
      scene.radii,
      this.viewState.hiddenNodeTypes,
      this.viewState.collapsedIds,
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
      null,
      this.hideNodeMask,
      this.cycleMask,
      this.nodeInstanceBuf,
    );
    this.renderer.uploadNodeInstances(this.nodeInstanceBuf, scene.communities.length);
  }

  private repackEdges(scene: ProcessedScene): void {
    if (!this.renderer) return;

    if (!this.viewState.showEdges) {
      this.renderer.uploadLines(new Float32Array(0), 0);

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
    );

    this.edgeBuf = buffer;
    this.renderer.uploadLines(this.edgeBuf, vertexCount);
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

    if (!isFinite(minX)) return;
    this.renderer.camera.fit(minX, minY, maxX, maxY);
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

    if (!this.renderer || !scene) return -1;
    if (this.pickerDirty) this.rebuildPicker(scene);
    if (!this.picker) return -1;

    const dpr = window.devicePixelRatio || 1;
    const [wx, wy] = this.renderer.camera.screenToWorld(sx * dpr, sy * dpr);
    // Hit radius in world coords corresponds to the rendered screen-px floor
    // (max(4, r*zoom)). At low zoom, the world-space hit area grows so tiny
    // dots stay clickable — so we search a box of that minimum radius around
    // the click, then refine.
    const zoom = this.renderer.camera.zoom || 1;
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

    if (idx !== this.hoveredIdx) {
      this.hoveredIdx = idx;
      const scene = this.visualizer.scene;

      if (scene) this.repackNodes(scene);
      this.dirty = true;
    }
  };

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
      this.repackCycle(scene);
      this.repackNodes(scene);
      this.repackEdges(scene);
      if (this.viewState.showHulls) this.repackHulls(scene);
      this.fitInitialView(scene);
      this.dirty = true;
    }

    if (scene) {
      this.reactToScene(scene);
      // Keep redrawing while a node is selected — the halo around the
      // selected node animates and would otherwise freeze the moment the
      // dirty flag clears.
      if (this.viewState.selectedId !== null) this.dirty = true;
      if (this.dirty && this.renderer) {
        this.renderer.draw();
        this.dirty = false;
      }
    } else if (this.dirty && this.renderer) {
      // Clear the canvas while the pipeline is still working so we don't
      // leave a previous scene visible behind the loading overlay.
      this.renderer.draw();
      this.dirty = false;
    }

    this.rafHandle = requestAnimationFrame(this.loop);
  };

  private teardown(): void {
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
    window.removeEventListener("resize", this.resizeHandler);
    for (const fn of this.cleanups) fn();
    this.cleanups = [];

    this.renderer?.camera.destroy();
    this.renderer = null;
  }

  <template>
    <canvas class="visualizer__canvas" {{this.setupCanvas}}></canvas>
    {{#if this.visualizer.state.isLoading}}
      <div class="visualizer__loading" role="status">
        Computing layout&hellip;
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
