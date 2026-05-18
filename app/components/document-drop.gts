import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { action } from "@ember/object";
import { service } from "@ember/service";

import { parseGraphJson } from "#lib/parser";
import { SchemaError } from "#lib/schema";

import type GraphLoaderService from "#services/graph-loader";

/**
 * App-wide file drop target. Rendered once in the application shell so a
 * graph JSON file dropped *anywhere*, on *any* route, is exactly
 * equivalent to picking a file on `/analyze`: parse → reset → load →
 * visualizer (all via the shared `graph-loader` service).
 *
 * Listeners live on `window` (not a rendered element) so the whole
 * viewport is the drop zone; the overlay is purely visual and only
 * appears while a file is actually being dragged over the page.
 */
export default class DocumentDrop extends Component {
  @service declare graphLoader: GraphLoaderService;

  @tracked isDragging = false;
  @tracked errorMessage: string | null = null;

  /** dragenter/dragleave fire per-element as the cursor crosses child
   *  boundaries; count them so the overlay doesn't flicker. */
  #depth = 0;

  #isFileDrag = (ev: DragEvent): boolean =>
    Array.from(ev.dataTransfer?.types ?? []).includes("Files");

  onDragEnter = (ev: DragEvent): void => {
    if (!this.#isFileDrag(ev)) return;
    this.#depth++;
    this.isDragging = true;
    this.errorMessage = null;
  };

  onDragOver = (ev: DragEvent): void => {
    if (!this.#isFileDrag(ev)) return;
    // Required, or the browser refuses the drop and just navigates to /
    // opens the file when the user releases.
    ev.preventDefault();
  };

  onDragLeave = (ev: DragEvent): void => {
    if (!this.#isFileDrag(ev)) return;
    this.#depth = Math.max(0, this.#depth - 1);
    if (this.#depth === 0) this.isDragging = false;
  };

  onDrop = (ev: DragEvent): void => {
    this.#depth = 0;
    this.isDragging = false;

    // The `/analyze` FileDrop the cursor is over already claimed this
    // drop (it calls `preventDefault`). Don't load it a second time.
    if (ev.defaultPrevented) return;
    if (!this.#isFileDrag(ev)) return;

    ev.preventDefault();

    const file = ev.dataTransfer?.files?.[0];

    if (file) void this.#load(file);
  };

  #teardown: () => void = (() => {
    if (typeof window === "undefined") return () => {};

    const handlers: [keyof WindowEventMap, (ev: DragEvent) => void][] = [
      ["dragenter", this.onDragEnter],
      ["dragover", this.onDragOver],
      ["dragleave", this.onDragLeave],
      ["drop", this.onDrop],
    ];

    for (const [type, handler] of handlers) {
      window.addEventListener(type, handler as EventListener);
    }

    return () => {
      for (const [type, handler] of handlers) {
        window.removeEventListener(type, handler as EventListener);
      }
    };
  })();

  willDestroy(): void {
    super.willDestroy();
    this.#teardown();
  }

  async #load(file: File): Promise<void> {
    try {
      const text = await file.text();
      const parsed = parseGraphJson(text);

      this.errorMessage = null;
      await this.graphLoader.open({ parsed, text, name: file.name });
    } catch (err) {
      this.errorMessage =
        err instanceof SchemaError
          ? err.message
          : `Failed to load: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  @action
  dismissError(): void {
    this.errorMessage = null;
  }

  <template>
    {{#if this.isDragging}}
      <div class="document-drop" role="presentation">
        <div class="document-drop__panel">
          <p class="document-drop__title">Drop a graph JSON file to analyze</p>
        </div>
      </div>
    {{/if}}
    {{#if this.errorMessage}}
      <div class="document-drop__error" role="alert">
        <span>{{this.errorMessage}}</span>
        <button type="button" {{on "click" this.dismissError}}>Dismiss</button>
      </div>
    {{/if}}
  </template>
}
