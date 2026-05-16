import Component from "@glimmer/component";
import { fn } from "@ember/helper";
import { on } from "@ember/modifier";
import { action } from "@ember/object";
import { service } from "@ember/service";

import { VerticalCollection } from "@html-next/vertical-collection";

import {
  createApplyGeometryModifier,
  createDragModifier,
  createResizeModifier,
} from "#lib/floating-panel";
import { findOrphans } from "#lib/orphans";

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
   * Memoize the orphans list by `graph.current` identity. Orphan
   * analysis is O(N + E) so a re-run on every render isn't actually
   * dangerous, but skipping it when nothing has changed keeps the
   * panel's render path predictable when the user clicks around. The
   * resulting array is sorted by label for stable display.
   */
  #lastGraph: LoadedGraph | null = null;
  #lastOrphans: OrphanEntry[] = [];

  get orphans(): OrphanEntry[] {
    // Skip the analysis when the panel is closed — nothing reads the
    // result, and a no-op getter is cheaper than even an O(N + E)
    // pass on a 10k-node graph.
    if (!this.viewState.orphansPanelOpen) return [];

    const g = this.graph.current;

    if (!g) return [];

    if (g !== this.#lastGraph) {
      // Cache miss: re-run the analysis. Same write-inside-the-branch
      // shape as the cycles panel's getter so the eslint
      // `ember/no-side-effects` rule reads this as a memoized
      // computation rather than an unconditional mutation.
      const entries: OrphanEntry[] = findOrphans(g).map((idx) => ({
        index: idx,
        id: g.ids[idx]!,
        label: g.labels[idx]!,
      }));

      entries.sort((a, b) => a.label.localeCompare(b.label));

      // Memoization writes — the rule otherwise flags any property
      // assignment inside a getter, but caching the analysis result
      // is the whole point.
      // eslint-disable-next-line ember/no-side-effects
      this.#lastGraph = g;
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
          >×</button>
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
                  {{#if (notEq entry.id entry.label)}}
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

function eq(a: unknown, b: unknown): boolean {
  return a === b;
}

function notEq(a: unknown, b: unknown): boolean {
  return a !== b;
}
