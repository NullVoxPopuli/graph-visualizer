import Component from "@glimmer/component";
import { cached } from "@glimmer/tracking";
import { action } from "@ember/object";
import { service } from "@ember/service";

import { VerticalCollection } from "@html-next/vertical-collection";
import { use } from "ember-resources";
import { getPromiseState, type State } from "reactiveweb/get-promise-state";
import { keepLatest } from "reactiveweb/keep-latest";

import {
  createApplyGeometryModifier,
  createDragModifier,
  createResizeModifier,
} from "#lib/floating-panel";
import IconX from "~icons/ph/x";

import type { PanelGeometry } from "#lib/floating-panel";
import type GraphService from "#services/graph";
import type ViewStateService from "#services/view-state";
import type VisualizerService from "#services/visualizer";

interface OrphanEntry {
  index: number;
  id: string;
  label: string;
}

/**
 * Floating panel that lists every "orphan" node in the loaded graph.
 *
 * An orphan is a node whose ancestor set contains no cycle — direct
 * sources (in-degree 0) plus everything they uniquely feed into. The
 * actual computation lives in `lib/orphans.ts`; this component only
 * presents the result with the same chrome as the cycles panel (drag
 * + resize + URL-backed geometry, virtualized list of clickable
 * rows).
 */
export default class OrphansPanel extends Component {
  @service declare viewState: ViewStateService;
  @service declare graph: GraphService;
  @service declare visualizer: VisualizerService;

  /**
   * The resident Rust session's orphan query for the current graph +
   * edge-type filter + declared roots. `null` when the panel is closed
   * or no graph is loaded (nothing to compute). The edge-type filter and
   * declared roots feed the Rust peel; the hidden-node-id / label-glob
   * filter is a JS post-pass applied in `computedOrphans`.
   */
  get orphanQuery(): Promise<Int32Array> | null {
    if (!this.viewState.orphansPanelOpen) return null;

    const g = this.graph.current;

    if (!g) return null;

    const hiddenIds = Int32Array.from(this.viewState.hiddenEdgeTypes);
    const rootIndices: number[] = [];

    for (const id of this.viewState.rootNodeIds) {
      const idx = g.idToIndex.get(id);

      if (idx !== undefined) rootIndices.push(idx);
    }

    return this.visualizer.orphanIndices(hiddenIds, Int32Array.from(rootIndices));
  }

  /** Promise state for {@link orphanQuery}; `null` when there's no query. */
  get orphanState(): State<Int32Array> | null {
    const promise = this.orphanQuery;

    return promise === null ? null : getPromiseState(promise);
  }

  /**
   * Orphans for display: the resolved indices minus any whose id is in
   * the effective hide set (a hidden node's edges drop off the canvas
   * too, so it shouldn't read as an orphan), sorted by label. `[]` until
   * the query resolves — `keepLatest` below is what stops that empty
   * window from flashing on every re-query.
   */
  @cached
  get computedOrphans(): OrphanEntry[] {
    const g = this.graph.current;
    const resolved = this.orphanState?.resolved;

    if (!g || !resolved) return [];

    const effectiveHidden = this.viewState.effectiveHiddenNodeIds(g);
    const entries: OrphanEntry[] = [];

    for (const idx of resolved) {
      const id = g.ids[idx]!;

      if (effectiveHidden.has(id)) continue;
      entries.push({ index: idx, id, label: g.labels[idx]! });
    }

    entries.sort((a, b) => a.label.localeCompare(b.label));

    return entries;
  }

  /**
   * The displayed orphan list, smoothed across the async re-query that
   * fires whenever roots/filters change. While the new query is in
   * flight `keepLatest` keeps the previous non-empty list visible
   * instead of letting the panel blank and jump; a settled empty result
   * (genuinely no orphans) still clears it, because `when` is false then.
   */
  @use private orphansLatest = keepLatest<OrphanEntry[]>({
    value: () => this.computedOrphans,
    when: () => this.orphanState?.isLoading ?? false,
  });

  get orphans(): OrphanEntry[] {
    return this.orphansLatest ?? [];
  }

  get selectedId(): string | null {
    return this.viewState.selectedId;
  }

  @action
  selectNode(id: string): void {
    this.viewState.selectedId = id;
    this.visualizer.focusOnId(id);
  }

  @action
  zoomInOnNode(id: string): void {
    this.viewState.selectedId = id;
    this.visualizer.zoomInOnId(id);
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
  declareRoot(id: string): void {
    this.viewState.toggleRootNodeId(id);
  }

  @action
  close(): void {
    this.viewState.orphansPanelOpen = false;
  }

  setupDrag = createDragModifier({
    panelSelector: ".orphans-panel",
    set: (g) => {
      this.viewState.orphansPanelGeometry = g;
    },
  });

  applyGeometry = createApplyGeometryModifier({
    getInitial: () => this.viewState.orphansPanelGeometry,
    registerReset: (cb) => this.viewState.registerGeometryReset(cb),
  });

  #setGeometry = (g: PanelGeometry): void => {
    this.viewState.orphansPanelGeometry = g;
  };

  resizeN = createResizeModifier({
    panelSelector: ".orphans-panel",
    edge: "n",
    set: this.#setGeometry,
  });
  resizeS = createResizeModifier({
    panelSelector: ".orphans-panel",
    edge: "s",
    set: this.#setGeometry,
  });
  resizeE = createResizeModifier({
    panelSelector: ".orphans-panel",
    edge: "e",
    set: this.#setGeometry,
  });
  resizeW = createResizeModifier({
    panelSelector: ".orphans-panel",
    edge: "w",
    set: this.#setGeometry,
  });
  resizeNW = createResizeModifier({
    panelSelector: ".orphans-panel",
    edge: "nw",
    set: this.#setGeometry,
  });
  resizeNE = createResizeModifier({
    panelSelector: ".orphans-panel",
    edge: "ne",
    set: this.#setGeometry,
  });
  resizeSW = createResizeModifier({
    panelSelector: ".orphans-panel",
    edge: "sw",
    set: this.#setGeometry,
  });
  resizeSE = createResizeModifier({
    panelSelector: ".orphans-panel",
    edge: "se",
    set: this.#setGeometry,
  });

  <template>
    {{#if this.viewState.orphansPanelOpen}}
      <aside class="panel orphans-panel" aria-label="Orphan list" {{this.applyGeometry}}>
        <div class="cycles-panel__titlebar" {{this.setupDrag}}>
          <h3 class="cycles-panel__title">
            Orphans
            <span class="cycles-panel__count">{{this.orphans.length}}</span>
          </h3>
          <button
            type="button"
            class="cycles-panel__close"
            aria-label="Close orphans panel"
            title="Close"
            {{on "click" this.close}}
          ><IconX /></button>
        </div>
        {{#if this.orphans.length}}
          <ol class="cycles-panel__list">
            <VerticalCollection
              @items={{this.orphans}}
              @key="id"
              @estimateHeight={{36}}
              @bufferSize={{2}}
              as |entry|
            >
              <li class="orphans-panel__row">
                <button
                  type="button"
                  class="cycles-panel__node {{if (eq entry.id this.selectedId) 'is-selected'}}"
                  title={{entry.id}}
                  {{on "click" (fn this.selectNode entry.id)}}
                  {{on "dblclick" (fn this.zoomInOnNode entry.id)}}
                  {{on "mouseenter" (fn this.hoverNode entry.id)}}
                  {{on "mouseleave" this.unhoverNode}}
                >
                  <span class="cycles-panel__node-label">{{entry.label}}</span>
                  {{#if (neq entry.id entry.label)}}
                    <code class="cycles-panel__node-id">{{entry.id}}</code>
                  {{/if}}
                </button>
                <button
                  type="button"
                  class="orphans-panel__root-btn"
                  title="Declare this node an intentional root: exclude it (and anything reachable only through it) from orphan detection"
                  {{on "click" (fn this.declareRoot entry.id)}}
                >declare root</button>
              </li>
            </VerticalCollection>
          </ol>
        {{else}}
          <p class="cycles-panel__empty">No orphan nodes — every node has incoming edges.</p>
        {{/if}}
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
