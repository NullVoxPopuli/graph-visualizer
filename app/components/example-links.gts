import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { fn } from "@ember/helper";
import { on } from "@ember/modifier";
import { action } from "@ember/object";
import { getPromiseState } from "reactiveweb/get-promise-state";

import { EXAMPLES, type Example } from "#lib/examples";
import { parseGraphJson } from "#lib/parser";

import type { LoadedGraph } from "#lib/types";

interface Signature {
  Args: {
    onParsed: (g: LoadedGraph) => void;
    /** Optional leading text before the list of links, e.g. "Try an example:". */
    prefix?: string;
  };
  Element: HTMLParagraphElement;
}

export default class ExampleLinks extends Component<Signature> {
  /** Mirrors `file-drop.gts`: the only piece of state we keep is the promise
   *  itself; everything else (loading, error message) comes from
   *  `getPromiseState`. */
  @tracked private promise: Promise<LoadedGraph> | null = null;
  examples = EXAMPLES;

  get state(): ReturnType<typeof getPromiseState<Promise<LoadedGraph>>> | null {
    return this.promise === null ? null : getPromiseState(this.promise);
  }

  get errorMessage(): string | null {
    const err = this.state?.error;

    if (!err) return null;
    const original = err.original;
    const msg = original instanceof Error ? original.message : String(original);

    return `Failed to load example: ${msg}`;
  }

  @action
  load(ex: Example, ev: Event): void {
    ev.preventDefault();
    if (this.state?.isLoading) return;
    this.promise = fetchExample(ex.url).then((g) => {
      this.args.onParsed(g);

      return g;
    });
  }

  <template>
    <p class="examples" ...attributes>
      {{#if @prefix}}<span class="examples__prefix">{{@prefix}}</span>{{/if}}
      {{#each this.examples as |ex i|}}
        {{#if i}}<span class="examples__sep">·</span>{{/if}}
        <a
          href={{ex.url}}
          class="examples__link"
          title={{ex.description}}
          {{on "click" (fn this.load ex)}}
        >{{ex.label}}</a>
      {{/each}}
      {{#if this.state.isLoading}}
        <span class="examples__status">loading…</span>
      {{/if}}
      {{#if this.errorMessage}}
        <span class="examples__error" role="alert">{{this.errorMessage}}</span>
      {{/if}}
    </p>
  </template>
}

async function fetchExample(url: string): Promise<LoadedGraph> {
  const resp = await fetch(url);

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const text = await resp.text();

  return parseGraphJson(text);
}
