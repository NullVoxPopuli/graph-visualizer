import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { on } from "@ember/modifier";
import { action } from "@ember/object";

import { getPromiseState } from "reactiveweb/get-promise-state";

import { parseGraphJson } from "#lib/parser";
import { SchemaError } from "#lib/schema";

import type { LoadedGraph } from "#lib/types";

export interface ParsedInput {
  parsed: LoadedGraph;
  text: string;
  name: string;
}

interface Signature {
  Args: { onParsed: (input: ParsedInput) => void };
  Element: HTMLDivElement;
}

export default class FileDrop extends Component<Signature> {
  @tracked private filePromise: Promise<LoadedGraph> | null = null;
  @tracked isDragging = false;
  inputId = `filedrop-${Math.random().toString(36).slice(2)}`;

  /**
   * Derived loading/error/resolved state for the in-flight file parse.
   * `getPromiseState` caches per-promise input, so re-reading this getter
   * during a render doesn't re-spawn or re-await work.
   */
  get state(): ReturnType<typeof getPromiseState<Promise<LoadedGraph>>> | null {
    return this.filePromise === null ? null : getPromiseState(this.filePromise);
  }

  get errorMessage(): string | null {
    const err = this.state?.error;

    if (!err) return null;

    const original = err.original;

    if (original instanceof SchemaError) return original.message;
    if (original instanceof Error) return `Failed to load: ${original.message}`;

    return `Failed to load: ${String(original)}`;
  }

  @action
  handleFile(file: File): void {
    this.filePromise = (async () => {
      const text = await file.text();
      const parsed = parseGraphJson(text);

      this.args.onParsed({ parsed, text, name: file.name });

      return parsed;
    })();
  }

  @action
  onPick(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const f = input.files?.[0];

    if (f) this.handleFile(f);
    input.value = "";
  }

  @action
  onDragOver(ev: DragEvent): void {
    ev.preventDefault();
    this.isDragging = true;
  }

  @action
  onDragLeave(): void {
    this.isDragging = false;
  }

  @action
  onDrop(ev: DragEvent): void {
    ev.preventDefault();
    this.isDragging = false;

    const f = ev.dataTransfer?.files?.[0];

    if (f) this.handleFile(f);
  }

  <template>
    <div
      class="filedrop {{if this.isDragging 'is-dragging'}}"
      {{on "dragover" this.onDragOver}}
      {{on "dragleave" this.onDragLeave}}
      {{on "drop" this.onDrop}}
      ...attributes
    >
      <label for={{this.inputId}} class="filedrop__label">
        <span class="filedrop__title">
          {{if this.state.isLoading "Loading…" "Drop a graph JSON file here"}}
        </span>
        <span class="filedrop__hint">or click to choose a file</span>
        <input
          id={{this.inputId}}
          type="file"
          accept="application/json,.json"
          class="filedrop__input"
          {{on "change" this.onPick}}
        />
      </label>
      {{#if this.errorMessage}}
        <p class="filedrop__error" role="alert">{{this.errorMessage}}</p>
      {{/if}}
    </div>
  </template>
}
