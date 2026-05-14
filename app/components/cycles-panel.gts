import Component from "@glimmer/component";
import { fn } from "@ember/helper";
import { on } from "@ember/modifier";
import { action } from "@ember/object";
import { service } from "@ember/service";

import { modifier } from "ember-modifier";

import { buildContraction } from "#lib/contract";
import { findAllCycles } from "#lib/cycle";
import { computeRadii } from "#lib/pack";

import type GraphService from "#services/graph";
import type ViewStateService from "#services/view-state";
import type VisualizerService from "#services/visualizer";

interface CycleNode {
  id: string;
  label: string;
}

interface CycleEntry {
  nodes: CycleNode[];
  /** stable key for `{{#each}}` — concatenated ids, deterministic per cycle. */
  key: string;
}

/**
 * Floating panel that enumerates every strongly-connected loop in the
 * graph. One entry per SCC (representative shortest cycle), so a tightly-
 * coupled component cluster shows up once rather than fanning out into
 * every overlapping elementary cycle. Clicking the entry header selects
 * the first node in the cycle; clicking a node row selects that node.
 * Selection triggers the existing red-ring highlight in the renderer, so
 * the click here ↔ visual feedback in the canvas.
 *
 * Runs on the same contraction the renderer uses (type filter +
 * collapsed + hidden nodes) so the listed cycles match what's drawn.
 *
 * The window is draggable by the title bar and resizable from the
 * bottom-right corner (native CSS `resize: both`). Geometry round-trips
 * through `viewState.cyclesPanelGeometry` so a shared URL preserves
 * exactly where the user left the panel.
 */
export default class CyclesPanel extends Component {
  @service declare viewState: ViewStateService;
  @service declare graph: GraphService;
  @service declare visualizer: VisualizerService;

  get cycles(): CycleEntry[] {
    const g = this.graph.current;

    if (!g) return [];

    const radii = computeRadii(g.inDegree, g.outDegree);
    const contraction = buildContraction(
      g,
      radii,
      this.viewState.hiddenNodeTypes,
      this.viewState.collapsedIds,
      this.viewState.hiddenNodeIds,
    );
    const remap = contraction?.nodeRemap ?? null;
    const cycles = findAllCycles(g, remap);

    return cycles.map((cycle) => {
      const nodes: CycleNode[] = cycle.map((idx) => ({
        id: g.ids[idx]!,
        label: g.labels[idx]!,
      }));

      return { nodes, key: nodes.map((n) => n.id).join("→") };
    });
  }

  get selectedId(): string | null {
    return this.viewState.selectedId;
  }

  @action
  selectNode(id: string): void {
    this.viewState.selectedId = id;
    // Bring the node into view too — the cycle's nodes may be scattered
    // across the canvas, and just selecting them without panning makes the
    // panel feel disconnected from the graph.
    this.visualizer.focusOnId(id);
  }

  @action
  hoverNode(id: string): void {
    this.visualizer.externalHoverId = id;
  }

  @action
  unhoverNode(): void {
    this.visualizer.externalHoverId = null;
  }

  @action
  close(): void {
    this.viewState.cyclesPanelOpen = false;
  }

  // ---- window dragging + resize persistence ----

  /**
   * Wire pointer-based drag on the title bar. The actual position lives in
   * the URL via `viewState.cyclesPanelGeometry`; this modifier just
   * captures the gesture and writes the new (left, top) at pointermove.
   * The size half is handled separately by `observePanelSize` reading the
   * element's own CSS resize.
   */
  setupDrag = modifier((handle: HTMLElement) => {
    let dragging: {
      pointerId: number;
      startX: number;
      startY: number;
      panelLeft: number;
      panelTop: number;
      panelWidth: number;
      panelHeight: number;
    } | null = null;

    const panelEl = (): HTMLElement | null =>
      handle.closest(".cycles-panel") as HTMLElement | null;

    const onPointerDown = (ev: PointerEvent): void => {
      if (ev.button !== 0) return;
      // Let clicks on interactive children (close button, future menu
      // bits) reach their own handlers instead of being captured for a
      // drag.
      const target = ev.target as HTMLElement | null;

      if (target && target.closest("button, input, a, select, textarea")) return;

      const panel = panelEl();

      if (!panel) return;

      const rect = panel.getBoundingClientRect();

      dragging = {
        pointerId: ev.pointerId,
        startX: ev.clientX,
        startY: ev.clientY,
        panelLeft: rect.left,
        panelTop: rect.top,
        panelWidth: rect.width,
        panelHeight: rect.height,
      };
      handle.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    };

    const onPointerMove = (ev: PointerEvent): void => {
      if (!dragging || ev.pointerId !== dragging.pointerId) return;

      const dx = ev.clientX - dragging.startX;
      const dy = ev.clientY - dragging.startY;
      // Clamp the title bar to stay visible — losing the drag handle
      // entirely is a UX dead end.
      const margin = 12;
      const left = clamp(
        dragging.panelLeft + dx,
        margin - dragging.panelWidth + 80,
        window.innerWidth - margin - 80,
      );
      const top = clamp(dragging.panelTop + dy, margin, window.innerHeight - margin - 24);

      this.viewState.cyclesPanelGeometry = {
        left,
        top,
        width: dragging.panelWidth,
        height: dragging.panelHeight,
      };
    };

    const onPointerUp = (ev: PointerEvent): void => {
      if (!dragging || ev.pointerId !== dragging.pointerId) return;
      handle.releasePointerCapture(dragging.pointerId);
      dragging = null;
    };

    handle.addEventListener("pointerdown", onPointerDown);
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", onPointerUp);
    handle.addEventListener("pointercancel", onPointerUp);

    return () => {
      handle.removeEventListener("pointerdown", onPointerDown);
      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointerup", onPointerUp);
      handle.removeEventListener("pointercancel", onPointerUp);
    };
  });

  /**
   * Apply the URL-backed geometry to the panel element. Setting `null` on
   * a field falls back to whatever CSS provided (default bottom-left
   * positioning + 50vh height), so a fresh URL still looks right.
   */
  applyGeometry = modifier((el: HTMLElement) => {
    const g = this.viewState.cyclesPanelGeometry;

    if (g === null) {
      el.style.left = "";
      el.style.top = "";
      el.style.right = "";
      el.style.bottom = "";
      el.style.width = "";
      el.style.height = "";

      return;
    }

    if (g.left !== null && g.top !== null) {
      el.style.left = `${g.left}px`;
      el.style.top = `${g.top}px`;
      el.style.right = "auto";
      el.style.bottom = "auto";
    }

    if (g.width !== null) el.style.width = `${g.width}px`;
    if (g.height !== null) el.style.height = `${g.height}px`;
  });

  /**
   * Watch the user's native bottom-right resize handle. On change, commit
   * the new width/height (alongside the current position) to the URL.
   * We compare against the last-committed value so this doesn't fight the
   * incoming URL state in a loop.
   */
  observePanelSize = modifier((el: HTMLElement) => {
    let lastW = 0;
    let lastH = 0;

    const obs = new ResizeObserver((entries) => {
      const entry = entries[0];

      if (!entry) return;

      const rect = el.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);

      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;

      const current = this.viewState.cyclesPanelGeometry;
      // Only persist after the user has actually grabbed the handle — we
      // know they did once the URL already has geometry OR the size
      // differs from the CSS default.
      const sameAsCurrent =
        current !== null && current.width === w && current.height === h;

      if (sameAsCurrent) return;

      this.viewState.cyclesPanelGeometry = {
        left: current?.left ?? rect.left,
        top: current?.top ?? rect.top,
        width: w,
        height: h,
      };
    });

    obs.observe(el);

    return () => obs.disconnect();
  });

  <template>
    {{#if (and this.cycles.length this.viewState.cyclesPanelOpen)}}
      <aside
        class="cycles-panel"
        aria-label="Cycle list"
        {{this.applyGeometry}}
        {{this.observePanelSize}}
      >
        <div class="cycles-panel__titlebar" {{this.setupDrag}}>
          <h3 class="cycles-panel__title">
            Cycles
            <span class="cycles-panel__count">{{this.cycles.length}}</span>
          </h3>
          <button
            type="button"
            class="cycles-panel__close"
            aria-label="Close cycles panel"
            title="Close"
            {{on "click" this.close}}
          >×</button>
        </div>
        <ol class="cycles-panel__list">
          {{#each this.cycles key="key" as |cycle i|}}
            <li class="cycles-panel__entry">
              <button
                type="button"
                class="cycles-panel__header"
                {{on "click" (fn this.selectNode cycle.nodes.0.id)}}
                title="Select the first node in this cycle"
              >
                <span class="cycles-panel__entry-index">#{{add i 1}}</span>
                <span class="cycles-panel__entry-summary">{{cycle.nodes.length}} nodes</span>
              </button>
              <ol class="cycles-panel__nodes">
                {{#each cycle.nodes key="id" as |node|}}
                  <li>
                    <button
                      type="button"
                      class="cycles-panel__node {{if (eq node.id this.selectedId) 'is-selected'}}"
                      {{on "click" (fn this.selectNode node.id)}}
                      {{on "mouseenter" (fn this.hoverNode node.id)}}
                      {{on "mouseleave" this.unhoverNode}}
                    >
                      <span class="cycles-panel__node-label">{{node.label}}</span>
                    </button>
                  </li>
                {{/each}}
              </ol>
            </li>
          {{/each}}
        </ol>
      </aside>
    {{/if}}
  </template>
}

function add(a: number, b: number): number {
  return a + b;
}

function and(a: unknown, b: unknown): unknown {
  return a && b;
}

function eq(a: unknown, b: unknown): boolean {
  return a === b;
}

function clamp(v: number, lo: number, hi: number): number {
  if (hi < lo) return lo;

  return v < lo ? lo : v > hi ? hi : v;
}
