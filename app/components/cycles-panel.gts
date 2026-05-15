import Component from "@glimmer/component";
import { fn } from "@ember/helper";
import { on } from "@ember/modifier";
import { action } from "@ember/object";
import { service } from "@ember/service";

import { buildContraction } from "#lib/contract";
import { canonicalCycleKey, findBundledCyclesViaRaw } from "#lib/cycle";
import {
  createApplyGeometryModifier,
  createDragModifier,
  createSizeObserverModifier,
} from "#lib/floating-panel";
import { computeRadii } from "#lib/pack";

import type { LoadedGraph } from "#lib/types";
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

  /**
   * Memoize the cycle list by graph + contraction inputs. `findAllCycles`
   * is exponential in the worst case (Johnson on a dense SCC), so we
   * absolutely cannot run it on every render — URL changes from selection,
   * hover, etc. would otherwise lock the main thread for seconds at a
   * time on a large graph.
   */
  #lastGraph: LoadedGraph | null = null;
  #lastCycleKey = "";
  #lastCycles: CycleEntry[] = [];

  get cycles(): CycleEntry[] {
    // Skip the expensive enumeration entirely when the panel is closed —
    // nothing in the template renders it, and `findAllCycles` on a
    // ~10k-node graph is enough to freeze the tab for several seconds.
    if (!this.viewState.cyclesPanelOpen) return [];

    const g = this.graph.current;

    if (!g) return [];

    const selectedId = this.viewState.selectedId;
    const hiddenTypesKey = serializeIntSet(this.viewState.hiddenNodeTypes);
    const collapsedKey = serializeStringSet(this.viewState.collapsedIds);
    const hiddenIdsKey = serializeStringSet(this.viewState.hiddenNodeIds);
    const key = `${hiddenTypesKey}|${collapsedKey}|${hiddenIdsKey}|${selectedId ?? ""}`;

    if (g === this.#lastGraph && key === this.#lastCycleKey) {
      return this.#lastCycles;
    }

    const radii = computeRadii(g.inDegree, g.outDegree);
    const contraction = buildContraction(
      g,
      radii,
      this.viewState.hiddenNodeTypes,
      this.viewState.collapsedIds,
      this.viewState.hiddenNodeIds,
    );
    const remap = contraction?.nodeRemap ?? null;
    // When a node is selected, scope the list to cycles whose bundled
    // form involves the selection (or its visible owner, when the
    // selection is a hidden file folded into a package). Without this,
    // selecting `@acme/billing` would also surface `utils → db` cycles
    // that have nothing to do with billing — accurate for the whole
    // graph but noise for someone investigating one node.
    let scopeIdx = -1;

    if (selectedId !== null) {
      const idx = g.idToIndex.get(selectedId);

      if (idx !== undefined) {
        scopeIdx = remap === null ? idx : remap[idx]!;
      }
    }

    const cycles = findBundledCyclesViaRaw(g, remap);
    // Dedupe by canonical node sequence — parallel raw edges between two
    // packages (e.g. lots of `file → file` imports) all contract to the
    // same bundled cycle, and listing the same `pkgA → pkgB` 13 times is
    // just noise.
    const seen = new Set<string>();
    const mapped: CycleEntry[] = [];

    for (const cycle of cycles) {
      if (scopeIdx >= 0 && !cycle.includes(scopeIdx)) continue;

      const ck = canonicalCycleKey(cycle);

      if (seen.has(ck)) continue;
      seen.add(ck);

      const nodes: CycleNode[] = cycle.map((idx) => ({
        id: g.ids[idx]!,
        label: g.labels[idx]!,
      }));

      mapped.push({ nodes, key: ck });
    }

    this.#lastGraph = g;
    this.#lastCycleKey = key;
    this.#lastCycles = mapped;

    return mapped;
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
  // Backed by `viewState.cyclesPanelGeometry`. The modifier factories
  // capture `this` so each component instance writes to its own slot.

  setupDrag = createDragModifier({
    panelSelector: ".cycles-panel",
    get: () => this.viewState.cyclesPanelGeometry,
    set: (g) => {
      this.viewState.cyclesPanelGeometry = g;
    },
  });

  applyGeometry = createApplyGeometryModifier(() => this.viewState.cyclesPanelGeometry);

  observePanelSize = createSizeObserverModifier(
    () => this.viewState.cyclesPanelGeometry,
    (g) => {
      this.viewState.cyclesPanelGeometry = g;
    },
  );

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
                {{on "click" (fn this.selectNode cycle.nodes.[0].id)}}
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
                      title={{node.id}}
                      {{on "click" (fn this.selectNode node.id)}}
                      {{on "mouseenter" (fn this.hoverNode node.id)}}
                      {{on "mouseleave" this.unhoverNode}}
                    >
                      <span class="cycles-panel__node-label">{{node.label}}</span>
                      {{#if (notEq node.id node.label)}}
                        <code class="cycles-panel__node-id">{{node.id}}</code>
                      {{/if}}
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

function serializeIntSet(set: Set<number>): string {
  if (set.size === 0) return "";

  return [...set].sort((a, b) => a - b).join(",");
}

function serializeStringSet(set: Set<string>): string {
  if (set.size === 0) return "";

  return [...set].sort().join(",");
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

function notEq(a: unknown, b: unknown): boolean {
  return a !== b;
}
