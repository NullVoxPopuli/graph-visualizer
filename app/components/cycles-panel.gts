import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { fn } from "@ember/helper";
import { on } from "@ember/modifier";
import { action } from "@ember/object";
import { service } from "@ember/service";

import { VerticalCollection } from "@html-next/vertical-collection";

import { toggleInSet } from "#lib/collapse-list";
import { buildContraction } from "#lib/contract";
import { canonicalCycleKey, findBundledCyclesViaRaw, hasAnyCycle } from "#lib/cycle";
import {
  createApplyGeometryModifier,
  createDragModifier,
  createResizeModifier,
} from "#lib/floating-panel";
import { computeRadii } from "#lib/pack";

import type { PanelGeometry } from "#lib/floating-panel";
import type { LoadedGraph } from "#lib/types";
import type GraphService from "#services/graph";
import type ViewStateService from "#services/view-state";
import type VisualizerService from "#services/visualizer";

interface CycleNode {
  id: string;
  label: string;
}

/**
 * One displayed chunk inside a cycle's node list. Adjacent nodes whose
 * canonical cycle is the same are grouped together — a run of nodes
 * that "belong to" this cycle becomes an `own` segment, a run of nodes
 * whose smallest containing cycle is some other one becomes a `ref`
 * segment that the template renders as a clickable `cycle#N` chip.
 *
 * `nodes` on a `ref` is the subset of *this* cycle's nodes that share
 * that canonical — expanding the chip surfaces them inline so the user
 * can see which positions in the current cycle map to the referenced
 * one.
 */
export interface CycleSegment {
  key: string;
  nodes: CycleNode[];
  /**
   * Set on segments whose nodes belong to a smaller cycle — the
   * template renders these as a `cycle#N` chip. `undefined` on
   * "own" segments (the cycle's unique nodes). A presence check
   * narrows the type for Glint inside the `{{#if seg.cycleId}}`
   * branch, which is why we don't use a discriminated `kind` union.
   */
  cycleId?: number;
}

interface CycleEntry {
  nodes: CycleNode[];
  /** 1-based, shortest-first. Stable across renders for a given graph. */
  id: number;
  segments: CycleSegment[];
  /**
   * Comma-joined list of referenced cycle ids (`"cycle#1, cycle#3"`)
   * computed from this cycle's ref segments — empty string when the
   * cycle is wholly its own nodes. Pre-formatted as a string so the
   * template can render it with a single mustache without a join
   * helper or comma-between dance.
   */
  containedLabel: string;
  /** stable key for `{{#each}}` — concatenated ids, deterministic per cycle. */
  key: string;
}

/**
 * Walk a cycle's node sequence and group adjacent nodes by their
 * canonical cycle id (the smallest cycle each node appears in). Nodes
 * whose canonical is this cycle's own id become "own" segments and
 * render as the actual node rows; runs of nodes whose canonical is
 * some smaller cycle become "ref" segments that the template renders
 * as a `cycle#N` chip, click-to-expand to surface the shared nodes
 * in place.
 *
 * The segment `key` is `<cycleId>-<segmentIndex>`, used for Glimmer's
 * `{{#each key="key"}}` and as the dedup key in `expandedRefs`.
 */
function buildCycleSegments(
  nodes: CycleNode[],
  cycleId: number,
  canonical: Map<string, number>,
): CycleSegment[] {
  const out: CycleSegment[] = [];
  let current: CycleSegment | null = null;

  for (const node of nodes) {
    const nodeCanonical = canonical.get(node.id) ?? cycleId;
    const isOwn = nodeCanonical === cycleId;
    const targetCycleId = isOwn ? undefined : nodeCanonical;

    if (current === null || current.cycleId !== targetCycleId) {
      const key = `${cycleId}-${out.length}`;

      current = { key, cycleId: targetCycleId, nodes: [node] };
      out.push(current);
    } else {
      current.nodes.push(node);
    }
  }

  return out;
}

/**
 * Count the distinct ref-cycle ids in a cycle's segments and format
 * as `"1 cycle"` / `"5 cycles"` for inline display in the header.
 * Returns `""` when the cycle has no ref segments — its body is all
 * own nodes, so there's nothing to advertise.
 */
function formatContainedLabel(segments: CycleSegment[]): string {
  const seen = new Set<number>();

  for (const seg of segments) {
    if (seg.cycleId !== undefined) seen.add(seg.cycleId);
  }

  if (seen.size === 0) return "";

  return `${seen.size} cycle${seen.size === 1 ? "" : "s"}`;
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
   * Memoize the *bundled* cycle list by graph + contraction inputs.
   * `findAllCycles` is exponential in the worst case (Johnson on a
   * dense SCC), so we absolutely cannot run it on every render — URL
   * changes from selection, hover, etc. would otherwise lock the main
   * thread for seconds at a time on a large graph. The per-cycle
   * `displayed` projection (head + hidden marker + tail) sits *above*
   * this cache so clicking the marker on one cycle doesn't trigger
   * another `findBundledCyclesViaRaw` pass — only the cheap `.map`
   * over the already-bundled list reruns.
   */
  #lastGraph: LoadedGraph | null = null;
  #lastCycleKey = "";
  #lastBundled: { nodes: CycleNode[]; key: string }[] = [];

  /**
   * Set of cycle keys whose body (the inner node list) the user has
   * collapsed. Each cycle's body renders by default (so the panel is
   * useful at a glance); clicking the header *adds* the cycle here
   * and the row becomes just its `cycle#N` label. Tracked-by-reassign
   * so Glimmer picks up the change.
   */
  @tracked private collapsedHeaders: Set<string> = new Set();

  /**
   * Cycle-ref segment keys (`<cycle.id>-<segmentIndex>`) the user has
   * expanded inline. Each ref segment in a cycle's body collapses to
   * a `cycle#Y` chip by default; clicking the chip adds its key here
   * and the segment's actual nodes render in place.
   */
  @tracked private expandedRefs: Set<string> = new Set();

  @action
  toggleCycleHeader(key: string): void {
    this.collapsedHeaders = toggleInSet(this.collapsedHeaders, key);
  }

  @action
  toggleCycleRef(segKey: string): void {
    this.expandedRefs = toggleInSet(this.expandedRefs, segKey);
  }

  /**
   * Reason the cycles list is empty — drives the empty-state copy.
   * `"none"` is the all-good case where there's something to show.
   * `"graph"` means the raw graph has no cycles at all (uses the cheap
   * back-edge DFS). `"scoped"` means cycles exist but the current view
   * (selected-node scope, hidden nodes, type filters) hides them all —
   * the user can recover by clearing the selection or unhiding things.
   */
  get emptyReason(): "none" | "graph" | "scoped" {
    if (this.cycles.length > 0) return "none";

    const g = this.graph.current;

    if (!g) return "graph";

    return hasAnyCycle(g) ? "scoped" : "graph";
  }

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

    if (g !== this.#lastGraph || key !== this.#lastCycleKey) {
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

      const rawBundled = findBundledCyclesViaRaw(g, remap);
      // Dedupe by canonical node sequence — parallel raw edges between two
      // packages (e.g. lots of `file → file` imports) all contract to the
      // same bundled cycle, and listing the same `pkgA → pkgB` 13 times is
      // just noise.
      const seen = new Set<string>();
      const bundled: { nodes: CycleNode[]; key: string }[] = [];

      for (const cycle of rawBundled) {
        if (scopeIdx >= 0 && !cycle.includes(scopeIdx)) continue;

        const ck = canonicalCycleKey(cycle);

        if (seen.has(ck)) continue;
        seen.add(ck);

        const nodes: CycleNode[] = cycle.map((idx) => ({
          id: g.ids[idx]!,
          label: g.labels[idx]!,
        }));

        bundled.push({ nodes, key: ck });
      }

      this.#lastGraph = g;
      this.#lastCycleKey = key;
      this.#lastBundled = bundled;
    }

    // Compute each node's canonical cycle id — the smallest cycle in
    // the current bundled list that contains it. `bundled` is already
    // sorted shortest-first, so the first cycle a node appears in is
    // its canonical one. Cached implicitly via `#lastBundled`'s cache
    // — recomputing this map on every render is cheap (linear in the
    // total node-count across cycles) compared with the bundling we
    // just avoided.
    const canonical = new Map<string, number>();

    for (let i = 0; i < this.#lastBundled.length; i++) {
      const cycleId = i + 1;

      for (const node of this.#lastBundled[i]!.nodes) {
        if (!canonical.has(node.id)) canonical.set(node.id, cycleId);
      }
    }

    return this.#lastBundled.map(({ nodes, key: ck }, idx) => {
      const id = idx + 1;
      const segments = buildCycleSegments(nodes, id, canonical);

      return {
        nodes,
        id,
        segments,
        containedLabel: formatContainedLabel(segments),
        key: ck,
      };
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
  // Backed by `viewState.cyclesPanelGeometry`. The modifier factories
  // capture `this` so each component instance writes to its own slot.

  setupDrag = createDragModifier({
    panelSelector: ".cycles-panel",
    set: (g) => {
      this.viewState.cyclesPanelGeometry = g;
    },
  });

  applyGeometry = createApplyGeometryModifier({
    getInitial: () => this.viewState.cyclesPanelGeometry,
    registerReset: (cb) => this.viewState.registerGeometryReset(cb),
  });

  #setGeometry = (g: PanelGeometry): void => {
    this.viewState.cyclesPanelGeometry = g;
  };

  resizeN = createResizeModifier({
    panelSelector: ".cycles-panel",
    edge: "n",
    set: this.#setGeometry,
  });
  resizeS = createResizeModifier({
    panelSelector: ".cycles-panel",
    edge: "s",
    set: this.#setGeometry,
  });
  resizeE = createResizeModifier({
    panelSelector: ".cycles-panel",
    edge: "e",
    set: this.#setGeometry,
  });
  resizeW = createResizeModifier({
    panelSelector: ".cycles-panel",
    edge: "w",
    set: this.#setGeometry,
  });
  resizeNW = createResizeModifier({
    panelSelector: ".cycles-panel",
    edge: "nw",
    set: this.#setGeometry,
  });
  resizeNE = createResizeModifier({
    panelSelector: ".cycles-panel",
    edge: "ne",
    set: this.#setGeometry,
  });
  resizeSW = createResizeModifier({
    panelSelector: ".cycles-panel",
    edge: "sw",
    set: this.#setGeometry,
  });
  resizeSE = createResizeModifier({
    panelSelector: ".cycles-panel",
    edge: "se",
    set: this.#setGeometry,
  });

  <template>
    {{#if this.viewState.cyclesPanelOpen}}
      <aside class="panel cycles-panel" aria-label="Cycle list" {{this.applyGeometry}}>
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
        {{#unless this.cycles.length}}
          <p class="cycles-panel__empty">
            {{#if (eq this.emptyReason "scoped")}}
              No cycles match the current view. Try clearing the selection (right-click in the
              canvas) or unhiding nodes.
            {{else}}
              This graph has no cycles.
            {{/if}}
          </p>
        {{/unless}}
        <ol class="cycles-panel__list">
          <VerticalCollection
            @items={{this.cycles}}
            @key="key"
            @estimateHeight={{120}}
            @bufferSize={{2}}
            as |cycle|
          >
            <li class="cycles-panel__entry">
              <button
                type="button"
                class="cycles-panel__header
                  {{unless (has this.collapsedHeaders cycle.key) 'is-expanded'}}"
                {{on "click" (fn this.toggleCycleHeader cycle.key)}}
                title="Toggle cycle details"
                aria-expanded={{unless (has this.collapsedHeaders cycle.key) "true" "false"}}
              >
                <span class="cycles-panel__entry-summary">{{cycle.nodes.length}} nodes</span>
                {{#if cycle.containedLabel}}
                  <span class="cycles-panel__entry-contains">contains
                    {{cycle.containedLabel}}</span>
                {{/if}}
              </button>
              {{#unless (has this.collapsedHeaders cycle.key)}}
                <ol class="cycles-panel__nodes">
                  {{#each cycle.segments key="key" as |seg|}}
                    {{#unless seg.cycleId}}
                      {{#each seg.nodes key="id" as |node|}}
                        <li>
                          <button
                            type="button"
                            class="cycles-panel__node
                              {{if (eq node.id this.selectedId) 'is-selected'}}"
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
                    {{/unless}}
                    {{#if seg.cycleId}}
                      <li>
                        <button
                          type="button"
                          class="cycle-ref"
                          {{on "click" (fn this.toggleCycleRef seg.key)}}
                          aria-expanded={{if (has this.expandedRefs seg.key) "true" "false"}}
                          title="Toggle which nodes here belong to cycle#{{seg.cycleId}}"
                        >
                          … cycle#{{seg.cycleId}}
                          ({{seg.nodes.length}}) — click to expand …
                        </button>
                        {{#if (has this.expandedRefs seg.key)}}
                          <ol class="cycles-panel__nodes cycles-panel__nodes--nested">
                            {{#each seg.nodes key="id" as |node|}}
                              <li>
                                <button
                                  type="button"
                                  class="cycles-panel__node
                                    {{if (eq node.id this.selectedId) 'is-selected'}}"
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
                        {{/if}}
                      </li>
                    {{/if}}
                  {{/each}}
                </ol>
              {{/unless}}
            </li>
          </VerticalCollection>
        </ol>
        <div class="panel__resize-handle panel__resize-handle--n" {{this.resizeN}}></div>
        <div class="panel__resize-handle panel__resize-handle--s" {{this.resizeS}}></div>
        <div class="panel__resize-handle panel__resize-handle--e" {{this.resizeE}}></div>
        <div class="panel__resize-handle panel__resize-handle--w" {{this.resizeW}}></div>
        <div class="panel__resize-handle panel__resize-handle--nw" {{this.resizeNW}}></div>
        <div class="panel__resize-handle panel__resize-handle--ne" {{this.resizeNE}}></div>
        <div class="panel__resize-handle panel__resize-handle--sw" {{this.resizeSW}}></div>
        <div class="panel__resize-handle panel__resize-handle--se" {{this.resizeSE}}></div>
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

function eq(a: unknown, b: unknown): boolean {
  return a === b;
}

function has(set: Set<string>, key: string): boolean {
  return set.has(key);
}

function notEq(a: unknown, b: unknown): boolean {
  return a !== b;
}
