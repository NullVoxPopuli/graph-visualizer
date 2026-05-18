import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { action } from "@ember/object";
import { service } from "@ember/service";

import { VerticalCollection } from "@html-next/vertical-collection";
import { getPromiseState } from "reactiveweb/get-promise-state";

import { toggleInSet } from "#lib/collapse-list";
import { buildContraction } from "#lib/contract";
import { bundleRawCyclesWithGroups, canonicalCycleKey, shortCycleId } from "#lib/cycle";
import {
  createApplyGeometryModifier,
  createDragModifier,
  createResizeModifier,
} from "#lib/floating-panel";
import { computeRadii } from "#lib/pack";
import IconArrowElbowDownRight from "~icons/ph/arrow-elbow-down-right";
import IconArrowRight from "~icons/ph/arrow-right";
import IconX from "~icons/ph/x";

import type { PanelGeometry } from "#lib/floating-panel";
import type { LoadedGraph } from "#lib/types";
import type GraphService from "#services/graph";
import type ViewStateService from "#services/view-state";
import type VisualizerService from "#services/visualizer";

interface RawCycleFile {
  id: string;
  label: string;
}

interface CycleNode {
  id: string;
  label: string;
  /**
   * When contraction is active and the raw node at this bundled step
   * differs from the bundled rep (i.e., the file got folded into its
   * owning package), `rawFiles` lists the underlying file(s) in
   * traversal order. Empty when the raw and bundled nodes match.
   * Multiple entries appear in two cases: consecutive same-rep raw
   * nodes collapsed into one bundled step (rare), or the cycle's
   * wrap-around closing raw node landed back on the head package.
   */
  rawFiles: RawCycleFile[];
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
   * Short cycle id of the *smaller* cycle this segment's nodes belong
   * to — the template renders it as a chip on the right of the
   * "click to expand" row. `undefined` on "own" segments (the cycle's
   * unique nodes). A presence check narrows the type for Glint inside
   * the `{{#if seg.cycleId}}` branch.
   */
  cycleId?: string;
}

interface CycleEntry {
  nodes: CycleNode[];
  /**
   * Short, deterministic id derived from the canonical cycle key
   * (see `shortCycleId`). Looks like a UUID's first segment — 8
   * lower-case hex chars, e.g. `a3f2b1c8`. Stable across reloads.
   */
  id: string;
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
  cycleId: string,
  canonical: Map<string, string>,
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
  const seen = new Set<string>();

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
   * Memoize the *fully built* CycleEntry list (nodes + id + segments +
   * containedLabel) keyed by graph identity and serialized contraction
   * inputs. `findAllCycles` is exponential in the worst case, so we
   * absolutely cannot re-run it on every render — but the post-pass
   * (shortCycleId hashing, canonical-cycle map, segment build) was
   * also surprisingly costly because it allocated fresh segment
   * arrays for every cycle on every read, and a `cycles` reference
   * change forces VerticalCollection to reconcile every visible row.
   *
   * Toggling the collapsed-headers / expanded-refs sets must not
   * invalidate this cache — those flags are template-level state, not
   * inputs to the cycle structure itself.
   */
  #lastGraph: LoadedGraph | null = null;
  #lastCycleKey = "";
  #lastRaw: number[][] | null = null;
  #lastEntries: CycleEntry[] = [];

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

    // Any cycle under the current edge-type filter? If yes but the list
    // is empty, the selection / hidden-node scope filtered them out
    // ("scoped"); if no, the (filtered) graph is genuinely acyclic.
    const p = this.visualizer.hasAnyCycle(Int32Array.from(this.viewState.hiddenEdgeTypes));

    if (!p) return "graph";

    return getPromiseState(p).resolved === true ? "scoped" : "graph";
  }

  get cycles(): CycleEntry[] {
    // Skip the expensive enumeration entirely when the panel is closed —
    // nothing in the template renders it, and `findAllCycles` on a
    // ~10k-node graph is enough to freeze the tab for several seconds.
    if (!this.viewState.cyclesPanelOpen) return [];

    const g = this.graph.current;

    if (!g) return [];

    // The exponential elementary-cycle enumeration runs once in the
    // resident Rust session, keyed (in the service) by graph + edge-type
    // filter. Everything below — contraction through the collapse remap,
    // dedupe, short ids — is the cheap synchronous post-pass on that
    // fixed raw list. While a fresh enumeration is in flight we keep the
    // previous entries so the panel never blanks or blocks.
    const rawPromise = this.visualizer.cycleRaw(
      Int32Array.from(this.viewState.hiddenEdgeTypes),
      1000,
    );

    if (!rawPromise) return [];

    const rawCycles = getPromiseState(rawPromise).resolved;

    if (!rawCycles) return this.#lastEntries;

    // Note: the selection is deliberately NOT part of this key. The list
    // is the full set of cycles for the current graph/filters; selecting
    // a node only moves the `is-selected` highlight (driven separately by
    // the `selectedId` getter). Scoping the list to the selection meant
    // every click on a cycle node re-filtered and rebuilt the list,
    // discarding the user's collapse/expand layout and visibly jumping
    // the panel — clicking a cycle to view it must be non-destructive.
    const hiddenTypesKey = serializeIntSet(this.viewState.hiddenNodeTypes);
    const hiddenEdgeTypesKey = serializeIntSet(this.viewState.hiddenEdgeTypes);
    const collapsedKey = serializeStringSet(this.viewState.collapsedIds);
    const hiddenIdsKey = serializeStringSet(this.viewState.hiddenNodeIds);
    const globKey = `${this.viewState.includeGlobs.join("|")}::${this.viewState.excludeGlobs.join("|")}`;
    const key = `${hiddenTypesKey}|${hiddenEdgeTypesKey}|${collapsedKey}|${hiddenIdsKey}|${globKey}`;

    if (g !== this.#lastGraph || key !== this.#lastCycleKey || rawCycles !== this.#lastRaw) {
      const radii = computeRadii(g.inDegree, g.outDegree);
      const contraction = buildContraction(
        g,
        radii,
        this.viewState.hiddenNodeTypes,
        this.viewState.collapsedIds,
        this.viewState.effectiveHiddenNodeIds(g),
      );
      const remap = contraction?.nodeRemap ?? null;
      const rawBundled = bundleRawCyclesWithGroups(rawCycles, remap);
      // Dedupe by canonical node sequence — parallel raw edges between two
      // packages (e.g. lots of `file <IconArrowRight /> file` imports) all contract to the
      // same bundled cycle, and listing the same `pkgA <IconArrowRight /> pkgB` 13 times is
      // just noise.
      const seen = new Set<string>();
      const bundled: { nodes: CycleNode[]; key: string }[] = [];

      for (const cycle of rawBundled) {
        const ck = canonicalCycleKey(cycle.bundled);

        if (seen.has(ck)) continue;
        seen.add(ck);

        const nodes: CycleNode[] = cycle.bundled.map((idx, i) => {
          const group = cycle.groups[i]!;
          // Show the underlying raw file(s) only when the bundled rep
          // differs from the raw node — i.e., contraction actually
          // folded a file into its owner. Same raw == same node, no
          // extra info needed. `groups[i]` is always non-empty.
          const rawFiles: RawCycleFile[] = [];

          for (const rawIdx of group) {
            if (rawIdx === idx) continue;
            rawFiles.push({ id: g.ids[rawIdx]!, label: g.labels[rawIdx]! });
          }

          return { id: g.ids[idx]!, label: g.labels[idx]!, rawFiles };
        });

        bundled.push({ nodes, key: ck });
      }

      // Pre-assign each cycle's short id (deterministic from its
      // canonical key). Two passes are needed because the canonical
      // cycle for each *node* is the short id of the smallest cycle
      // that contains it, so we have to know every cycle's id before
      // building the node <IconArrowRight /> canonical map.
      const usedIds = new Set<string>();
      const cycleIds = bundled.map(({ key: ck }) => shortCycleId(ck, usedIds));

      const canonical = new Map<string, string>();

      for (let i = 0; i < bundled.length; i++) {
        const id = cycleIds[i]!;

        for (const node of bundled[i]!.nodes) {
          if (!canonical.has(node.id)) canonical.set(node.id, id);
        }
      }

      const entries: CycleEntry[] = bundled.map(({ nodes, key: ck }, idx) => {
        const id = cycleIds[idx]!;
        const segments = buildCycleSegments(nodes, id, canonical);

        return {
          nodes,
          id,
          segments,
          containedLabel: formatContainedLabel(segments),
          key: ck,
        };
      });

      this.#lastGraph = g;
      this.#lastCycleKey = key;
      this.#lastRaw = rawCycles;
      this.#lastEntries = entries;
    }

    return this.#lastEntries;
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
          ><IconX /></button>
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
                <code class="cycle-id">{{cycle.id}}</code>
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
                            {{#if (neq node.id node.label)}}
                              <code class="cycles-panel__node-id">{{node.id}}</code>
                            {{/if}}
                            {{#if node.rawFiles.length}}
                              <span class="cycles-panel__node-raw">
                                {{#each node.rawFiles key="id" as |file index|}}
                                  {{#if index}}
                                    <IconArrowRight />
                                  {{else}}
                                    <IconArrowElbowDownRight />
                                  {{/if}}
                                  {{file.label}}
                                {{/each}}
                              </span>
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
                          title="Toggle which nodes here belong to cycle {{seg.cycleId}}"
                        >
                          <span class="cycle-ref__label">
                            … ({{seg.nodes.length}}) — click to expand …
                          </span>
                          <code class="cycle-id">{{seg.cycleId}}</code>
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
                                  {{#if (neq node.id node.label)}}
                                    <code class="cycles-panel__node-id">{{node.id}}</code>
                                  {{/if}}
                                  {{#if node.rawFiles.length}}
                                    <span class="cycles-panel__node-raw">
                                      {{#each node.rawFiles key="id" as |file index|}}
                                        {{#if index}}
                                          <IconArrowRight />
                                        {{else}}
                                          <IconArrowElbowDownRight />
                                        {{/if}}
                                        {{file.label}}
                                      {{/each}}
                                    </span>
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

function has(set: Set<string>, key: string): boolean {
  return set.has(key);
}
