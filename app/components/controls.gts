import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { action } from "@ember/object";
import { service } from "@ember/service";

import { getPromiseState } from "reactiveweb/get-promise-state";

import IconCaretLeft from "~icons/ph/caret-left";
import IconCaretRight from "~icons/ph/caret-right";
import IconGear from "~icons/ph/gear";
import IconX from "~icons/ph/x";

import Search from "./search.gts";

import type GraphService from "#services/graph";
import type ViewStateService from "#services/view-state";
import type VisualizerService from "#services/visualizer";

/** Stable empty arg so the unfiltered orphan query keeps one cache key
 *  in the visualizer service (no per-render allocation / key churn). */
const NO_FILTER = new Int32Array(0);

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
  @service declare visualizer: VisualizerService;

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

  /**
   * `<select>` change for the clustering mode. Empty option → Louvain
   * (clears `viewState.clusterBy`). For the "custom path" option the
   * select stores a sentinel string the UI inspects; the actual mode
   * comes from `customMetaPath` below.
   */
  @action
  setClusterMode(ev: Event): void {
    const v = (ev.target as HTMLSelectElement).value;

    if (v === "" || v === "louvain") {
      this.viewState.clusterBy = null;

      return;
    }

    if (v === "custom") {
      // The text input ships a real `meta.x.y` value on input; flipping
      // the select to `custom` with an empty path stays in custom mode
      // visually but doesn't activate it until the user types.
      const path = this.customMetaPath;

      this.viewState.clusterBy = path.length > 0 ? `meta.${path}` : null;

      return;
    }

    this.viewState.clusterBy = v;
  }

  /**
   * Live-edited meta path (the part after `meta.`). Stored locally so
   * the user can type freely; only commits to `viewState.clusterBy`
   * once it's non-empty.
   */
  @tracked customMetaPath = "";

  @action
  setCustomMetaPath(ev: Event): void {
    const v = (ev.target as HTMLInputElement).value;

    this.customMetaPath = v;
    this.viewState.clusterBy = v.length > 0 ? `meta.${v}` : null;
  }

  /**
   * Which `<option>` is currently selected — drives the `selected`
   * attribute on the template. Maps the URL value back to the four
   * fixed modes; any `meta.*` value is "custom".
   */
  get currentClusterMode(): "louvain" | "id" | "label" | "type" | "custom" {
    const v = this.viewState.clusterBy;

    if (v === null) return "louvain";
    if (v === "id" || v === "label" || v === "type") return v;
    if (v.startsWith("meta.")) return "custom";

    return "louvain";
  }

  /**
   * Value displayed in the meta-path text input. When the mode is
   * `custom`, mirror the path back out of `viewState.clusterBy` so
   * URL-driven changes show up; otherwise show the locally-edited
   * draft so an in-progress path doesn't vanish on every keystroke.
   */
  get displayedCustomMetaPath(): string {
    const v = this.viewState.clusterBy;

    if (v !== null && v.startsWith("meta.")) return v.slice("meta.".length);

    return this.customMetaPath;
  }

  /**
   * Input change for the `segments=` knob. Empty / zero / negative
   * clears the param (LCP returns to its natural-clustering mode);
   * any positive integer forces that many clusters.
   */
  @action
  setSegments(ev: Event): void {
    const raw = (ev.target as HTMLInputElement).value.trim();
    const n = Number.parseInt(raw, 10);

    this.viewState.segments = Number.isFinite(n) && n > 0 ? n : null;
  }

  get displayedSegments(): string {
    const s = this.viewState.segments;

    return s !== null ? String(s) : "";
  }

  @action
  toggleCyclesOnly(): void {
    this.viewState.cyclesOnly = !this.viewState.cyclesOnly;
  }

  @action
  toggleEdgeType(id: number): void {
    this.viewState.toggleHiddenEdgeType(id);
  }

  @action
  toggleNodeType(id: number): void {
    this.viewState.toggleHiddenNodeType(id);
  }

  /**
   * Draft text for the two glob input fields. Local-only — only the
   * patterns the user actually commits with the "Add" button (or Enter)
   * land in `viewState.includeGlobs` / `excludeGlobs` and from there
   * into the URL.
   */
  @tracked private includeDraft = "";
  @tracked private excludeDraft = "";

  get includeGlobs(): string[] {
    return this.viewState.includeGlobs;
  }

  get excludeGlobs(): string[] {
    return this.viewState.excludeGlobs;
  }

  @action
  updateIncludeDraft(event: Event): void {
    this.includeDraft = (event.target as HTMLInputElement).value;
  }

  @action
  updateExcludeDraft(event: Event): void {
    this.excludeDraft = (event.target as HTMLInputElement).value;
  }

  @action
  submitIncludeGlob(event: Event): void {
    event.preventDefault();

    const value = this.includeDraft;

    this.viewState.addIncludeGlob(value);
    this.includeDraft = "";
  }

  @action
  submitExcludeGlob(event: Event): void {
    event.preventDefault();

    const value = this.excludeDraft;

    this.viewState.addExcludeGlob(value);
    this.excludeDraft = "";
  }

  @action
  removeIncludeGlob(pattern: string): void {
    this.viewState.removeIncludeGlob(pattern);
  }

  @action
  removeExcludeGlob(pattern: string): void {
    this.viewState.removeExcludeGlob(pattern);
  }

  @action
  clearCollapsed(): void {
    this.viewState.clearCollapsed();
  }

  get collapsedCount(): number {
    return this.viewState.collapsedIds.size;
  }

  @action
  toggleCyclesPanel(): void {
    if (this.viewState.cyclesPanelOpen) {
      // Close — leave any saved geometry alone so a re-open lands the
      // panel back where the user last placed it.
      this.viewState.cyclesPanelOpen = false;

      return;
    }

    // Open — drop any saved geometry first. A previous session may
    // have left the panel at coordinates that are off-screen on this
    // viewport; flipping `cyclesPanelOpen` to true alone would render
    // the panel where the user can't see it and make the button look
    // dead. Resetting to the CSS default position is harmless when
    // geometry was already null.
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

  @action
  toggleOrphansPanel(): void {
    if (this.viewState.orphansPanelOpen) {
      this.viewState.orphansPanelOpen = false;

      return;
    }

    // Same off-screen-recovery behavior as `toggleCyclesPanel`:
    // clear any saved geometry on open so the panel lands at its CSS
    // default position regardless of where a previous session left
    // it.
    this.viewState.orphansPanelGeometry = null;
    this.viewState.orphansPanelOpen = true;
  }

  /**
   * Same shape as `showCyclesPanelButton`: visible whenever the graph
   * has any orphans (in-degree-zero nodes), regardless of whether
   * the panel is already open — clicking still gives the user a way
   * to dismiss + re-open when the saved geometry has wandered off.
   */
  get showOrphansPanelButton(): boolean {
    return this.graph.current !== null && this.hasAnyOrphans;
  }

  /**
   * Whether the orphans-panel button should show. Backed by the
   * resident Rust session's *unfiltered* orphan analysis (one stable,
   * service-memoized query, resolved once after load — no per-render
   * worker traffic, no flicker as edge-type filters toggle). Returns
   * `false` until that first result lands; the scene overlay covers
   * that window. Behavior nuance vs. before: the button now reflects
   * whether the graph has orphans at all, independent of the edge-type
   * filter (previously it hid when filtering removed every orphan).
   */
  get hasAnyOrphans(): boolean {
    if (!this.graph.current) return false;

    const promise = this.visualizer.orphanIndices(NO_FILTER, NO_FILTER);

    if (!promise) return false;

    return (getPromiseState(promise).resolved?.length ?? 0) > 0;
  }

  /**
   * Drop the persisted info/cycles panel geometries so they re-render at
   * their CSS default positions, which sit inside the viewport. Useful
   * when a saved URL has a panel positioned off-screen — e.g. dragged
   * to the right edge on a wide monitor, then opened on a smaller one.
   * Calls through to `viewState.recenterPanels()` which clears the URL
   * params *and* imperatively invokes each apply modifier's registered
   * reset callback — geometry isn't tracked anymore, so the URL clear
   * by itself wouldn't update the DOM.
   */
  @action
  recenterPanels(): void {
    this.viewState.recenterPanels();
  }

  /**
   * Visible whenever a graph is loaded. We can't gate on "has custom
   * geometry?" anymore — the geometry fields are intentionally non-
   * tracked (writing them must not re-render the controls panel), so
   * a getter reading them wouldn't update when they flipped to non-
   * null. Always-on costs one harmless button row when the user
   * hasn't moved anything; if they have, the click clears it. Same
   * "always available when a graph is loaded" pattern as
   * `showCyclesPanelButton`.
   */
  get showRecenterPanelsButton(): boolean {
    return this.graph.current !== null;
  }

  /**
   * Whether the currently-loaded graph contains any directed cycle.
   * Backed by the resident Rust session's unfiltered cycle check (one
   * stable, service-memoized query resolved once after load — no
   * per-render worker traffic, no flicker as edge filters toggle).
   * `false` until that first result lands / when nothing is loaded.
   * Reflects whether the graph has cycles at all, independent of the
   * edge-type filter (same nuance as the orphans button).
   */
  get hasAnyCycles(): boolean {
    if (!this.graph.current) return false;

    const p = this.visualizer.hasAnyCycle(NO_FILTER);

    if (!p) return false;

    return getPromiseState(p).resolved === true;
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

  /**
   * Nodes the user has declared intentional roots (orphans-panel
   * "declare root" button). Same id→label resolution as `hiddenNodes`
   * so the controls panel can list them readably and offer an undo.
   */
  get roots(): { id: string; label: string }[] {
    const ids = this.viewState.rootNodeIds;

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
  undeclareRoot(id: string): void {
    this.viewState.toggleRootNodeId(id);
  }

  @action
  clearRoots(event: MouseEvent): void {
    // Same rationale as `clearHiddenNodes`: the button sits in the
    // section's `<summary>`, so swallow the click to keep it from
    // toggling the parent `<details>`.
    event.stopPropagation();
    this.viewState.clearRootNodes();
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
  setControlsOpen(next: boolean): void {
    // Each caller passes the target state explicitly rather than
    // inverting `controlsOpen`: that getter is a *derived* value (URL
    // param OR a screen-size default when the param is absent), so on
    // a fresh small-screen load the param is unset and the default is
    // "collapsed" — resizing larger flips the default to "open" while
    // the panel is still visually collapsed. Inverting the getter then
    // computes the wrong target. The two buttons have unambiguous
    // intent (the gear only renders while collapsed, the in-panel
    // toggle only while open), so we drive the state directly.
    // View Transitions handle the swap if available. Inside the
    // callback rAFs are paused, so the setter's rAF-batched router
    // transition would deadlock — `flushPending` forces it through
    // synchronously so the browser captures the post-mutation DOM
    // for the "new" snapshot. Each shell carries its own
    // view-transition-name in styles.css, so the panel and gear get
    // independent enter/exit animations (no shared-name snapshot
    // stretching).
    //
    // The directional class on :root is what lets the stylesheet
    // animate the `::view-transition-group` (not the inner snapshot):
    // the group is the only place a live `backdrop-filter` works
    // (the image-pair is `isolation: isolate`), but a single group
    // selector can't tell an open from a close, so the class encodes
    // it. Animating the group means the blurred box scales/fades with
    // the panel instead of the blur lingering at full size.
    const doc = document as Document & {
      startViewTransition?: (cb: () => Promise<void> | void) => {
        finished?: Promise<unknown>;
      };
    };

    if (typeof doc.startViewTransition === "function") {
      const root = document.documentElement;
      const dirClass = next ? "controls-opening" : "controls-closing";

      root.classList.add(dirClass);

      const transition = doc.startViewTransition(async () => {
        this.viewState.controlsOpen = next;
        await this.viewState.flushPending();
      });

      const done = (): void => root.classList.remove(dirClass);

      // `finished` resolves when the animation ends (or rejects if the
      // transition is skipped/aborted) — clean the class up either way.
      transition.finished?.then(done, done);
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
          {{on "click" (fn this.setControlsOpen false)}}
          title="Hide controls"
          aria-expanded="true"
          aria-label="Hide controls"
        >
          <IconCaretLeft aria-hidden="true" />
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
            class="cluster-by"
            title="Cluster nodes by the longest common prefix of their id, label, type, or a custom meta path. Empty / Louvain falls back to topology-based community detection."
          >
            <span>cluster by</span>
            <select {{on "change" this.setClusterMode}}>
              <option value="louvain" selected={{eq this.currentClusterMode "louvain"}}>
                Louvain (default)
              </option>
              <option value="id" selected={{eq this.currentClusterMode "id"}}>id</option>
              <option value="label" selected={{eq this.currentClusterMode "label"}}>label</option>
              <option value="type" selected={{eq this.currentClusterMode "type"}}>type</option>
              <option value="custom" selected={{eq this.currentClusterMode "custom"}}>
                meta path…
              </option>
            </select>
            {{#if (eq this.currentClusterMode "custom")}}
              <input
                type="text"
                class="cluster-by__path"
                placeholder="e.g. team or layer.tier"
                value={{this.displayedCustomMetaPath}}
                {{on "input" this.setCustomMetaPath}}
                aria-label="Meta path to cluster by (dot-separated, without the `meta.` prefix)"
              />
            {{/if}}
            {{#if (neq this.currentClusterMode "louvain")}}
              <input
                type="number"
                class="cluster-by__segments"
                min="1"
                step="1"
                placeholder="segments"
                value={{this.displayedSegments}}
                {{on "input" this.setSegments}}
                title="Target number of clusters. Empty = natural LCP (wherever the strings diverge)."
                aria-label="Target cluster count for the LCP clusterer (blank for natural)"
              />
            {{/if}}
          </label>
          <label
            title="Hide every visible node that doesn't sit on at least one cycle. Lets you focus on the cyclic backbone of the graph without manually grooming filters."
          >
            <input
              type="checkbox"
              checked={{this.viewState.cyclesOnly}}
              {{on "change" this.toggleCyclesOnly}}
            />
            cycles only
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
        <details class="controls__section controls__details" open>
          <summary class="controls__section-label"><IconCaretRight
              class="summary-caret"
            />filters</summary>
          {{#if this.edgeTypes.length}}
            <div class="controls__filter-group">
              <div class="controls__filter-label">edge types</div>
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
          <div class="controls__filter-group">
            <div
              class="controls__filter-label"
              title="Only show nodes whose label matches at least one pattern. Wildcards: * (any chars) and ? (single char). Empty list means everything passes."
            >include labels</div>
            <form class="controls__glob-form" {{on "submit" this.submitIncludeGlob}}>
              <input
                type="text"
                class="controls__glob-input"
                placeholder="e.g. src/**"
                value={{this.includeDraft}}
                {{on "input" this.updateIncludeDraft}}
              />
              <button type="submit" class="controls__glob-add">Add</button>
            </form>
            {{#if this.includeGlobs.length}}
              <ul class="controls__glob-list">
                {{#each this.includeGlobs as |pattern|}}
                  <li class="controls__glob">
                    <code class="controls__glob-pattern">{{pattern}}</code>
                    <button
                      type="button"
                      class="controls__glob-remove"
                      title="Remove this include pattern"
                      {{on "click" (fn this.removeIncludeGlob pattern)}}
                    ><IconX /></button>
                  </li>
                {{/each}}
              </ul>
            {{/if}}
          </div>
          <div class="controls__filter-group">
            <div
              class="controls__filter-label"
              title="Hide nodes whose label matches any pattern. Exclude wins over include."
            >exclude labels</div>
            <form class="controls__glob-form" {{on "submit" this.submitExcludeGlob}}>
              <input
                type="text"
                class="controls__glob-input"
                placeholder="e.g. *.test.ts"
                value={{this.excludeDraft}}
                {{on "input" this.updateExcludeDraft}}
              />
              <button type="submit" class="controls__glob-add">Add</button>
            </form>
            {{#if this.excludeGlobs.length}}
              <ul class="controls__glob-list">
                {{#each this.excludeGlobs as |pattern|}}
                  <li class="controls__glob">
                    <code class="controls__glob-pattern">{{pattern}}</code>
                    <button
                      type="button"
                      class="controls__glob-remove"
                      title="Remove this exclude pattern"
                      {{on "click" (fn this.removeExcludeGlob pattern)}}
                    ><IconX /></button>
                  </li>
                {{/each}}
              </ul>
            {{/if}}
          </div>
        </details>
        {{#if this.hiddenNodes.length}}
          <details class="controls__section controls__details">
            <summary class="controls__section-head">
              <IconCaretRight class="summary-caret" />
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
        {{#if this.roots.length}}
          <details class="controls__section controls__details">
            <summary class="controls__section-head">
              <IconCaretRight class="summary-caret" />
              <span class="controls__section-label">roots ({{this.roots.length}})</span>
              <button
                type="button"
                class="controls__section-action"
                {{on "click" this.clearRoots}}
                title="Clear every declared root"
              >clear</button>
            </summary>
            <ul class="controls__hidden-list">
              {{#each this.roots as |r|}}
                <li class="controls__hidden">
                  <button
                    type="button"
                    class="controls__hidden-row"
                    title="Undeclare {{r.label}} as a root"
                    {{on "click" (fn this.undeclareRoot r.id)}}
                  >
                    <span class="controls__hidden-label">{{r.label}}</span>
                    <code class="controls__hidden-id">{{r.id}}</code>
                  </button>
                </li>
              {{/each}}
            </ul>
          </details>
        {{/if}}
        <details class="controls__section controls__details">
          <summary class="controls__section-label"><IconCaretRight
              class="summary-caret"
            />layout</summary>
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
              {{on "click" this.toggleCyclesPanel}}
              title={{if
                this.viewState.cyclesPanelOpen
                "Close the cycle list panel"
                "Open the cycle list panel"
              }}
            >{{if this.viewState.cyclesPanelOpen "Hide cycles" "Show cycles"}}</button>
          {{/if}}
          {{#if this.showOrphansPanelButton}}
            <button
              type="button"
              {{on "click" this.toggleOrphansPanel}}
              title={{if
                this.viewState.orphansPanelOpen
                "Close the orphan list panel"
                "Open the orphan list panel"
              }}
            >{{if this.viewState.orphansPanelOpen "Hide orphans" "Show orphans"}}</button>
          {{/if}}
          {{#if this.showRecenterPanelsButton}}
            <button
              type="button"
              {{on "click" this.recenterPanels}}
              title="Bring floating panels back into the viewport at their default positions"
            >Recenter panels</button>
          {{/if}}
        </div>
        <p class="controls__hint">
          drag / wheel: pan · ctrl+wheel / pinch: zoom · click: select · right-click: clear
        </p>
      </div>
    {{else}}
      <button
        type="button"
        class="controls__open"
        {{on "click" (fn this.setControlsOpen true)}}
        title="Show controls"
        aria-expanded="false"
        aria-label="Show controls"
      >
        <IconGear aria-hidden="true" />
      </button>
    {{/if}}
  </template>
}
