import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { action } from "@ember/object";
import { service } from "@ember/service";

import { modifier } from "ember-modifier";
import { IncrementalEach } from "ember-primitives";

import type GraphService from "#services/graph";
import type ViewStateService from "#services/view-state";
import type VisualizerService from "#services/visualizer";

interface Match {
  id: string;
  label: string;
  focused: boolean;
}

const MIN_QUERY_LENGTH = 3;
const MAX_RESULTS = 20;

export default class Search extends Component {
  @service declare graph: GraphService;
  @service declare viewState: ViewStateService;
  @service declare visualizer: VisualizerService;

  @tracked private query = "";
  @tracked private focusedIdx = -1;
  @tracked private isOpen = false;

  private inputEl: HTMLInputElement | null = null;

  /**
   * Document-level Cmd/Ctrl+K shortcut. Bound only while this component is
   * mounted so we don't leak listeners when the visualizer is torn down.
   */
  hotkey = modifier(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k") {
        ev.preventDefault();
        this.inputEl?.focus();
        this.inputEl?.select();
      }
    };

    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("keydown", onKey);
    };
  });

  registerInput = modifier((el: HTMLInputElement) => {
    this.inputEl = el;

    return () => {
      this.inputEl = null;
    };
  });

  /**
   * Top matches. `startsWith` matches on id or label rank above plain
   * `includes` matches; results from each bucket are deduped and capped
   * at MAX_RESULTS combined. Requires MIN_QUERY_LENGTH chars before
   * filtering — at tens of thousands of nodes, scanning on every keystroke
   * down to 1-char prefixes is way too much churn for too little signal.
   */
  get matches(): Match[] {
    const q = this.query.trim().toLowerCase();

    if (q.length < MIN_QUERY_LENGTH) return [];

    const g = this.graph.current;

    if (!g) return [];

    const starts: { id: string; label: string }[] = [];
    const contains: { id: string; label: string }[] = [];
    const N = g.ids.length;

    for (let i = 0; i < N; i++) {
      if (starts.length >= MAX_RESULTS && contains.length >= MAX_RESULTS) break;

      const id = g.ids[i]!;
      const label = g.labels[i]!;
      const idL = id.toLowerCase();
      const labelL = label.toLowerCase();

      if (idL.startsWith(q) || labelL.startsWith(q)) {
        if (starts.length < MAX_RESULTS) starts.push({ id, label });
      } else if (idL.includes(q) || labelL.includes(q)) {
        if (contains.length < MAX_RESULTS) contains.push({ id, label });
      }
    }

    const combined = [...starts, ...contains].slice(0, MAX_RESULTS);

    return combined.map((m, i) => ({ ...m, focused: i === this.focusedIdx }));
  }

  get hint(): string | null {
    const len = this.query.trim().length;

    if (len === 0) return null;
    if (len < MIN_QUERY_LENGTH) return `Type at least ${MIN_QUERY_LENGTH} characters.`;
    if (this.matches.length === 0) return "No matches.";

    return null;
  }

  @action
  onInput(ev: Event): void {
    this.query = (ev.target as HTMLInputElement).value;
    this.focusedIdx = -1;
    this.isOpen = true;
  }

  @action
  onFocus(): void {
    this.isOpen = true;
  }

  @action
  onBlur(): void {
    // Wait long enough for a mousedown-driven select to land before the
    // dropdown disappears.
    window.setTimeout(() => {
      this.isOpen = false;
    }, 120);
  }

  @action
  onKeyDown(ev: KeyboardEvent): void {
    const m = this.matches;

    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      this.isOpen = true;
      this.focusedIdx = Math.min(this.focusedIdx + 1, m.length - 1);
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      this.focusedIdx = Math.max(this.focusedIdx - 1, 0);
    } else if (ev.key === "Enter") {
      ev.preventDefault();

      const pick = m[this.focusedIdx >= 0 ? this.focusedIdx : 0];

      if (pick) this.select(pick.id);
    } else if (ev.key === "Escape") {
      this.isOpen = false;
      this.inputEl?.blur();
    }
  }

  @action
  select(id: string): void {
    this.viewState.selectedId = id;
    this.visualizer.focusOnId(id);
    this.query = "";
    this.focusedIdx = -1;
    this.isOpen = false;
    this.inputEl?.blur();
  }

  <template>
    <div class="search" {{this.hotkey}}>
      <input
        type="text"
        class="search__input"
        placeholder="Search nodes (⌘K / Ctrl+K)…"
        value={{this.query}}
        autocomplete="off"
        spellcheck="false"
        {{this.registerInput}}
        {{on "input" this.onInput}}
        {{on "focus" this.onFocus}}
        {{on "blur" this.onBlur}}
        {{on "keydown" this.onKeyDown}}
      />
      {{#if this.isOpen}}
        {{#if this.matches.length}}
          <ul class="search__results" role="listbox">
            <IncrementalEach @items={{this.matches}} as |m|>
              <li
                class="search__result {{if m.focused 'is-focused'}}"
                role="option"
                {{on "mousedown" (fn this.select m.id)}}
              >
                <span class="search__result-label">{{m.label}}</span>
                <code class="search__result-id">{{m.id}}</code>
              </li>
            </IncrementalEach>
          </ul>
        {{else if this.hint}}
          <p class="search__hint">{{this.hint}}</p>
        {{/if}}
      {{/if}}
    </div>
  </template>
}
