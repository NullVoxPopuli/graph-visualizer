import Component from "@glimmer/component";
import { fn } from "@ember/helper";
import { on } from "@ember/modifier";
import { action } from "@ember/object";
import { service } from "@ember/service";

import { hasAnyCycle } from "#lib/cycle";

import Search from "./search.gts";

import type GraphService from "#services/graph";
import type ViewStateService from "#services/view-state";

const REPULSION_MIN = 1;
const REPULSION_MAX = 30;
const REPULSION_STEP = 0.5;
const NODE_DIST_MIN = 5;
const NODE_DIST_MAX = 120;
const NODE_DIST_STEP = 2;
const CLUSTER_DIST_MIN = 30;
const CLUSTER_DIST_MAX = 800;
const CLUSTER_DIST_STEP = 10;
const CLUSTERING_MIN = 0.3;
const CLUSTERING_MAX = 3;
const CLUSTERING_STEP = 0.1;

interface EdgeTypeRow {
  id: number;
  name: string;
  count: number;
  hidden: boolean;
}

interface NodeTypeRow {
  id: number;
  name: string;
  count: number;
  hidden: boolean;
}

interface Signature {
  Args: {
    onResetView: () => void;
  };
}

export default class Controls extends Component<Signature> {
  @service declare viewState: ViewStateService;
  @service declare graph: GraphService;

  /**
   * Node-type breakdown for the filter section. Returns an empty list when
   * fewer than two distinct types are present in the loaded graph — at one
   * type the filter is just an "everything on/off" switch, which isn't
   * worth surfacing.
   */
  get nodeTypes(): NodeTypeRow[] {
    const g = this.graph.current;

    if (!g) return [];

    const names = g.nodeTypeNames;

    if (names.length < 2) return [];

    const counts = new Int32Array(names.length);

    for (let i = 0; i < g.nodeTypeIds.length; i++) counts[g.nodeTypeIds[i]!]!++;

    const hidden = this.viewState.hiddenNodeTypes;
    const out: NodeTypeRow[] = [];

    for (let id = 0; id < names.length; id++) {
      if (counts[id] === 0) continue;
      out.push({
        id,
        name: names[id] === "" ? "untyped" : names[id]!,
        count: counts[id]!,
        hidden: hidden.has(id),
      });
    }

    return out;
  }

  /**
   * Edge-type breakdown for the filter section. Returns an empty list when
   * the loaded graph has fewer than two distinct edge types (no point
   * surfacing the filter at all).
   */
  get edgeTypes(): EdgeTypeRow[] {
    const g = this.graph.current;

    if (!g) return [];

    const names = g.edgeTypeNames;
    const ids = g.edgeTypeIds;

    if (names.length < 2) return [];

    const counts = new Int32Array(names.length);

    for (let i = 0; i < ids.length; i++) counts[ids[i]!]!++;

    const hidden = this.viewState.hiddenEdgeTypes;
    const out: EdgeTypeRow[] = [];

    for (let id = 0; id < names.length; id++) {
      if (counts[id] === 0) continue;
      out.push({
        id,
        name: names[id] === "" ? "untyped" : names[id]!,
        count: counts[id]!,
        hidden: hidden.has(id),
      });
    }

    return out;
  }

  @action
  toggleEdges(): void {
    this.viewState.showEdges = !this.viewState.showEdges;
  }

  @action
  toggleHulls(): void {
    this.viewState.showHulls = !this.viewState.showHulls;
  }

  @action
  toggleArrows(): void {
    this.viewState.showArrows = !this.viewState.showArrows;
  }

  @action
  toggleClusterByLabel(): void {
    this.viewState.clusterByLabel = !this.viewState.clusterByLabel;
  }

  @action
  toggleEdgeType(id: number): void {
    this.viewState.toggleHiddenEdgeType(id);
  }

  @action
  toggleNodeType(id: number): void {
    this.viewState.toggleHiddenNodeType(id);
  }

  @action
  clearCollapsed(): void {
    this.viewState.clearCollapsed();
  }

  get collapsedCount(): number {
    return this.viewState.collapsedIds.size;
  }

  @action
  openCyclesPanel(): void {
    // Also drop any saved geometry: a previous session may have left
    // the panel at coordinates that are off-screen on this viewport,
    // in which case flipping `cyclesPanelOpen` to true would render
    // the panel where the user can't see it — making "Show cycles"
    // look like a dead button. Resetting to the CSS default position
    // is harmless when geometry was already null.
    this.viewState.cyclesPanelGeometry = null;
    this.viewState.cyclesPanelOpen = true;
  }

  /**
   * Surface the "Show cycles" button whenever the graph actually has
   * cycles — regardless of the `cyclesPanelOpen` flag. Previously the
   * button hid as soon as `cyclesPanelOpen` flipped to `true`, which
   * created a dead-zone: a stale URL with `cyclesPanelOpen=1` plus a
   * selection scoped to a node that isn't in any cycle meant the
   * cycles panel rendered nothing *and* the button was gone, leaving
   * no way to re-summon it. Keeping the button visible while cycles
   * exist costs a tiny bit of redundancy when the panel is also on
   * screen but makes the recovery path obvious.
   */
  get showCyclesPanelButton(): boolean {
    return this.graph.current !== null && this.hasAnyCycles;
  }

  /**
   * Drop the persisted info/cycles panel geometries so they re-render at
   * their CSS default positions, which sit inside the viewport. Useful
   * when a saved URL has a panel positioned off-screen — e.g. dragged
   * to the right edge on a wide monitor, then opened on a smaller one.
   * Only offered when at least one panel actually has a custom position
   * stored; otherwise the button does nothing visible.
   */
  @action
  recenterPanels(): void {
    this.viewState.infoPanelGeometry = null;
    this.viewState.cyclesPanelGeometry = null;
  }

  get showRecenterPanelsButton(): boolean {
    return this.viewState.infoPanelGeometry !== null || this.viewState.cyclesPanelGeometry !== null;
  }

  /**
   * Whether the currently-loaded graph contains any directed cycle at
   * all. Uses the fast `hasAnyCycle` back-edge DFS so this footer stays
   * cheap even when the user is dragging sliders — it returns at the
   * very first back edge rather than enumerating the whole cycle set.
   * Returns `false` when no graph is loaded so the footer reads
   * accurately on the initial empty state too.
   */
  get hasAnyCycles(): boolean {
    const g = this.graph.current;

    if (!g) return false;

    return hasAnyCycle(g);
  }

  /**
   * Hidden nodes (set via the info panel's "Hide node" button). Each
   * entry pairs the id with its current label so the controls panel can
   * show something readable; if the id no longer resolves (different
   * graph loaded) we fall back to the raw id.
   */
  get hiddenNodes(): { id: string; label: string }[] {
    const ids = this.viewState.hiddenNodeIds;

    if (ids.size === 0) return [];

    const g = this.graph.current;
    const out: { id: string; label: string }[] = [];

    for (const id of ids) {
      const idx = g?.idToIndex.get(id);

      out.push({ id, label: idx !== undefined ? (g!.labels[idx] ?? id) : id });
    }

    out.sort((a, b) => a.label.localeCompare(b.label));

    return out;
  }

  @action
  unhideNode(id: string): void {
    this.viewState.toggleHiddenNodeId(id);
  }

  @action
  clearHiddenNodes(event: MouseEvent): void {
    // The button lives inside the section's `<summary>`, where a click
    // would otherwise bubble up and toggle the parent `<details>` open
    // or closed as a side-effect of restoring nodes. Stop the bubble so
    // "show all" only does its one job.
    event.stopPropagation();
    this.viewState.clearHiddenNodes();
  }

  @action
  setRepulsion(ev: Event): void {
    const v = Number.parseFloat((ev.target as HTMLInputElement).value);

    if (Number.isFinite(v)) this.viewState.repulsion = v;
  }

  @action
  setNodeDistance(ev: Event): void {
    const v = Number.parseFloat((ev.target as HTMLInputElement).value);

    if (Number.isFinite(v)) this.viewState.nodeDistance = v;
  }

  @action
  setClusterDistance(ev: Event): void {
    const v = Number.parseFloat((ev.target as HTMLInputElement).value);

    if (Number.isFinite(v)) this.viewState.clusterDistance = v;
  }

  @action
  setClustering(ev: Event): void {
    const v = Number.parseFloat((ev.target as HTMLInputElement).value);

    if (Number.isFinite(v) && v > 0) this.viewState.clustering = v;
  }

  @action
  toggleControls(): void {
    const next = !this.viewState.controlsOpen;
    // View Transitions handle the swap if available. Inside the
    // callback rAFs are paused, so the setter's rAF-batched router
    // transition would deadlock — `flushPending` forces it through
    // synchronously so the browser captures the post-mutation DOM
    // for the "new" snapshot. Each shell carries its own
    // view-transition-name in styles.css, so the panel and gear get
    // independent enter/exit animations (no shared-name snapshot
    // stretching) — nothing extra to inject here.
    const doc = document as Document & {
      startViewTransition?: (cb: () => Promise<void> | void) => unknown;
    };

    if (typeof doc.startViewTransition === "function") {
      doc.startViewTransition(async () => {
        this.viewState.controlsOpen = next;
        await this.viewState.flushPending();
      });
    } else {
      this.viewState.controlsOpen = next;
    }
  }

  <template>
    {{#if this.viewState.controlsOpen}}
      <div class="panel controls">
        <button
          type="button"
          class="controls__toggle"
          {{on "click" this.toggleControls}}
          title="Hide controls"
          aria-expanded="true"
          aria-label="Hide controls"
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          ><polyline points="15 18 9 12 15 6"></polyline></svg>
        </button>
        <Search />
        <div class="controls__row">
          <label>
            <input
              type="checkbox"
              checked={{this.viewState.showEdges}}
              {{on "change" this.toggleEdges}}
            />
            edges
          </label>
          <label
            title="Arrowhead at the source end of each edge — the node that listed the edge in its outgoing list. Off keeps the graph less busy."
          >
            <input
              type="checkbox"
              checked={{this.viewState.showArrows}}
              {{on "change" this.toggleArrows}}
            />
            arrows
          </label>
          <label>
            <input
              type="checkbox"
              checked={{this.viewState.showHulls}}
              {{on "change" this.toggleHulls}}
            />
            cluster hulls
          </label>
          <label
            title="Group nodes by the longest common prefix of their labels (split on `/` or `.`). Useful when the graph is organized by file path or package."
          >
            <input
              type="checkbox"
              checked={{this.viewState.clusterByLabel}}
              {{on "change" this.toggleClusterByLabel}}
            />
            cluster by label
          </label>
        </div>
        {{#if this.nodeTypes.length}}
          <div class="controls__section">
            <div class="controls__section-label">node types</div>
            <div class="controls__types">
              {{#each this.nodeTypes as |t|}}
                <label class="controls__type">
                  <input
                    type="checkbox"
                    checked={{not t.hidden}}
                    {{on "change" (fn this.toggleNodeType t.id)}}
                  />
                  <span class="controls__type-name">{{t.name}}</span>
                  <span class="controls__type-count">{{t.count}}</span>
                </label>
              {{/each}}
            </div>
          </div>
        {{/if}}
        {{#if this.edgeTypes.length}}
          <div class="controls__section">
            <div class="controls__section-label">edge types</div>
            <div class="controls__types">
              {{#each this.edgeTypes as |t|}}
                <label class="controls__type">
                  <input
                    type="checkbox"
                    checked={{not t.hidden}}
                    {{on "change" (fn this.toggleEdgeType t.id)}}
                  />
                  <span class="controls__type-name">{{t.name}}</span>
                  <span class="controls__type-count">{{t.count}}</span>
                </label>
              {{/each}}
            </div>
          </div>
        {{/if}}
        {{#if this.hiddenNodes.length}}
          <details class="controls__section controls__details">
            <summary class="controls__section-head">
              <span class="controls__section-label">hidden nodes ({{this.hiddenNodes.length}})</span>
              <button
                type="button"
                class="controls__section-action"
                {{on "click" this.clearHiddenNodes}}
                title="Show all hidden nodes again"
              >show all</button>
            </summary>
            <ul class="controls__hidden-list">
              {{#each this.hiddenNodes as |h|}}
                <li class="controls__hidden">
                  <button
                    type="button"
                    class="controls__hidden-row"
                    title="Show {{h.label}}"
                    {{on "click" (fn this.unhideNode h.id)}}
                  >
                    <span class="controls__hidden-label">{{h.label}}</span>
                    <code class="controls__hidden-id">{{h.id}}</code>
                  </button>
                </li>
              {{/each}}
            </ul>
          </details>
        {{/if}}
        <details class="controls__section controls__details">
          <summary class="controls__section-label">layout</summary>
          <label class="controls__slider">
            <span class="controls__slider-name">node distance</span>
            <input
              type="range"
              min={{NODE_DIST_MIN}}
              max={{NODE_DIST_MAX}}
              step={{NODE_DIST_STEP}}
              value={{this.viewState.nodeDistance}}
              {{on "change" this.setNodeDistance}}
            />
            <span class="controls__slider-value">{{this.viewState.nodeDistance}}</span>
          </label>
          <label class="controls__slider">
            <span class="controls__slider-name">cluster distance</span>
            <input
              type="range"
              min={{CLUSTER_DIST_MIN}}
              max={{CLUSTER_DIST_MAX}}
              step={{CLUSTER_DIST_STEP}}
              value={{this.viewState.clusterDistance}}
              {{on "change" this.setClusterDistance}}
            />
            <span class="controls__slider-value">{{this.viewState.clusterDistance}}</span>
          </label>
          <label class="controls__slider">
            <span class="controls__slider-name">repulsion</span>
            <input
              type="range"
              min={{REPULSION_MIN}}
              max={{REPULSION_MAX}}
              step={{REPULSION_STEP}}
              value={{this.viewState.repulsion}}
              {{on "change" this.setRepulsion}}
            />
            <span class="controls__slider-value">{{this.viewState.repulsion}}</span>
          </label>
          <label
            class="controls__slider"
            title="Louvain resolution. Higher = more, smaller communities; lower = bigger, clingier ones."
          >
            <span class="controls__slider-name">clustering</span>
            <input
              type="range"
              min={{CLUSTERING_MIN}}
              max={{CLUSTERING_MAX}}
              step={{CLUSTERING_STEP}}
              value={{this.viewState.clustering}}
              {{on "change" this.setClustering}}
            />
            <span class="controls__slider-value">{{this.viewState.clustering}}</span>
          </label>
        </details>
        <div class="controls__row">
          <button type="button" {{on "click" @onResetView}}>Reset view</button>
          {{#if this.collapsedCount}}
            <button
              type="button"
              {{on "click" this.clearCollapsed}}
              title="Reset all node-level expand / collapse toggles"
            >Clear toggles ({{this.collapsedCount}})</button>
          {{/if}}
          {{#if this.showCyclesPanelButton}}
            <button
              type="button"
              {{on "click" this.openCyclesPanel}}
              title="Open the cycle list panel"
            >Show cycles</button>
          {{/if}}
          {{#if this.showRecenterPanelsButton}}
            <button
              type="button"
              {{on "click" this.recenterPanels}}
              title="Bring floating panels back into the viewport at their default positions"
            >Recenter panels</button>
          {{/if}}
        </div>
        {{#if this.graph.current}}
          <p class="controls__cycles-status">
            {{#if this.hasAnyCycles}}
              There is at least one cycle.
            {{else}}
              There are no cycles.
            {{/if}}
          </p>
        {{/if}}
        <p class="controls__hint">
          drag / wheel: pan · ctrl+wheel / pinch: zoom · click: select · right-click: clear
        </p>
      </div>
    {{else}}
      <button
        type="button"
        class="controls__open"
        {{on "click" this.toggleControls}}
        title="Show controls"
        aria-expanded="false"
        aria-label="Show controls"
      >
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        ><circle cx="12" cy="12" r="3"></circle><path
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
          ></path></svg>
      </button>
    {{/if}}
  </template>
}

function not(v: unknown): boolean {
  return !v;
}
