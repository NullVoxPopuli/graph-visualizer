import Component from "@glimmer/component";
import { action } from "@ember/object";
import { service } from "@ember/service";

import { VerticalCollection } from "@html-next/vertical-collection";

import {
  createApplyGeometryModifier,
  createDragModifier,
  createResizeModifier,
} from "#lib/floating-panel";
import { findOrphans } from "#lib/orphans";
import IconX from "~icons/ph/x";

import type { PanelGeometry } from "#lib/floating-panel";
import type { LoadedGraph } from "#lib/types";
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
   * Memoize the orphans list by `graph.current` identity, the hidden-
   * edge-type set, and the effective hide-id set (per-id "Hide" +
   * label glob filters). Orphan analysis is O(N + E) so re-running on
   * every render isn't catastrophic, but skipping it when nothing
   * changed keeps the panel's render path predictable as the user
   * clicks around.
   *
   * Note that `findOrphans` itself only takes an edge-type filter —
   * hidden-node-ids and glob filters are applied as a post-pass:
   * orphans are computed against the full graph (so a node's "real"
   * orphan status doesn't depend on what the user's hidden), then any
   * orphan whose id is in the effective hide set is dropped from the
   * displayed list. This matches the renderer's behavior — a hidden
   * node's edges drop out of the canvas too — without forcing
   * `findOrphans` to grow another knob.
   */
  #lastGraph: LoadedGraph | null = null;
  #lastCacheKey = "";
  #lastOrphans: OrphanEntry[] = [];

  get orphans(): OrphanEntry[] {
    // Skip the analysis when the panel is closed — nothing reads the
    // result, and a no-op getter is cheaper than even an O(N + E)
    // pass on a 10k-node graph.
    if (!this.viewState.orphansPanelOpen) return [];

    const g = this.graph.current;

    if (!g) return [];

    const hiddenEdgeTypes = this.viewState.hiddenEdgeTypes;
    const effectiveHidden = this.viewState.effectiveHiddenNodeIds(g);
    const cacheKey = `${serializeIntSet(hiddenEdgeTypes)}|${serializeStringSet(effectiveHidden)}`;

    if (g !== this.#lastGraph || cacheKey !== this.#lastCacheKey) {
      // Cache miss: re-run the analysis. Same write-inside-the-branch
      // shape as the cycles panel's getter so the eslint
      // `ember/no-side-effects` rule reads this as a memoized
      // computation rather than an unconditional mutation.
      const rawOrphans = findOrphans(g, hiddenEdgeTypes);
      const entries: OrphanEntry[] = [];

      for (const idx of rawOrphans) {
        const id = g.ids[idx]!;

        if (effectiveHidden.has(id)) continue;
        entries.push({ index: idx, id, label: g.labels[idx]! });
      }

      entries.sort((a, b) => a.label.localeCompare(b.label));

      // Memoization writes — the rule otherwise flags any property
      // assignment inside a getter, but caching the analysis result
      // is the whole point.
      // eslint-disable-next-line ember/no-side-effects
      this.#lastGraph = g;
      // eslint-disable-next-line ember/no-side-effects
      this.#lastCacheKey = cacheKey;
      // eslint-disable-next-line ember/no-side-effects
      this.#lastOrphans = entries;
    }

    return this.#lastOrphans;
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
  hoverNode(id: string): void {
    this.visualizer.externalHoverId = id;
  }

  @action
  unhoverNode(): void {
    this.visualizer.externalHoverId = null;
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
              <li>
                <button
                  type="button"
                  class="cycles-panel__node {{if (eq entry.id this.selectedId) 'is-selected'}}"
                  title={{entry.id}}
                  {{on "click" (fn this.selectNode entry.id)}}
                  {{on "mouseenter" (fn this.hoverNode entry.id)}}
                  {{on "mouseleave" this.unhoverNode}}
                >
                  <span class="cycles-panel__node-label">{{entry.label}}</span>
                  {{#if (neq entry.id entry.label)}}
                    <code class="cycles-panel__node-id">{{entry.id}}</code>
                  {{/if}}
                </button>
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

function serializeIntSet(set: Set<number>): string {
  if (set.size === 0) return "";

  return [...set].sort((a, b) => a - b).join(",");
}

function serializeStringSet(set: Set<string>): string {
  if (set.size === 0) return "";

  return [...set].sort().join(",");
}
