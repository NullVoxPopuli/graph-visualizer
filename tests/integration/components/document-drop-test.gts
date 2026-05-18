import { render, settled, waitUntil } from "@ember/test-helpers";
import { module, test } from "qunit";
import { setupRenderingTest } from "ember-qunit";

import DocumentDrop from "#components/document-drop";
import { stubRouterTransitions } from "#test-helpers/render";

import type GraphService from "#services/graph";

interface DT {
  types: string[];
  files?: File[];
}

function fireDrag(type: string, dataTransfer: DT): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });

  Object.defineProperty(ev, "dataTransfer", { value: dataTransfer });
  window.dispatchEvent(ev);

  return ev;
}

const GRAPH_JSON = JSON.stringify({
  nodes: [{ id: "a", edges: ["b"] }, { id: "b" }],
});

module("Integration | document-drop", function (hooks) {
  setupRenderingTest(hooks);

  hooks.beforeEach(async function () {
    stubRouterTransitions(this.owner);

    // IndexedDB is shared across tests in the browser; a graph another
    // test persisted would otherwise be restored into this one.
    const graph = this.owner.lookup("service:graph") as GraphService;

    await graph.clear();
    await graph.restored;
  });

  hooks.afterEach(async function () {
    // Don't leave a persisted graph behind for other modules to restore.
    await (this.owner.lookup("service:graph") as GraphService).clear();
  });

  test("the overlay appears while a file is dragged over the page and clears on leave", async function (assert) {
    await render(<template><DocumentDrop /></template>);

    assert.dom(".document-drop").doesNotExist("hidden when nothing is being dragged");

    fireDrag("dragenter", { types: ["Files"] });
    await settled();
    assert.dom(".document-drop").exists("overlay shows for a file drag");

    fireDrag("dragleave", { types: ["Files"] });
    await settled();
    assert.dom(".document-drop").doesNotExist("overlay clears when the drag leaves");
  });

  test("ignores drags that aren't files (in-app element drags)", async function (assert) {
    await render(<template><DocumentDrop /></template>);

    fireDrag("dragenter", { types: ["text/plain"] });
    await settled();

    assert.dom(".document-drop").doesNotExist("no overlay for a non-file drag");
  });

  test("dropping a file anywhere loads the graph and goes to the visualizer", async function (assert) {
    const graph = this.owner.lookup("service:graph") as GraphService;
    const router = this.owner.lookup("service:router") as unknown as {
      transitionTo: (...a: unknown[]) => unknown;
    };
    const calls: unknown[][] = [];

    router.transitionTo = (...args: unknown[]): Promise<unknown> => {
      calls.push(args);

      return Promise.resolve();
    };

    await render(<template><DocumentDrop /></template>);

    const file = new File([GRAPH_JSON], "graph.json", { type: "application/json" });

    fireDrag("drop", { types: ["Files"], files: [file] });

    await waitUntil(() => calls.some((c) => c[0] === "view"), { timeout: 2000 });

    assert.strictEqual(graph.current?.ids.length, 2, "the dropped graph was loaded");
    assert.ok(
      calls.some((c) => c[0] === "view"),
      "handed off to the visualizer, same as the analyze screen",
    );
  });

  test("a drop already handled by the analyze drop zone is not double-loaded", async function (assert) {
    const graph = this.owner.lookup("service:graph") as GraphService;

    await render(<template><DocumentDrop /></template>);

    const file = new File([GRAPH_JSON], "graph.json", { type: "application/json" });
    const ev = new Event("drop", { bubbles: true, cancelable: true });

    Object.defineProperty(ev, "dataTransfer", { value: { types: ["Files"], files: [file] } });
    // Simulate the inner FileDrop having already claimed it.
    ev.preventDefault();
    window.dispatchEvent(ev);
    await settled();

    assert.strictEqual(graph.current, null, "window handler bailed on the already-handled drop");
  });

  test("an invalid file surfaces an error instead of navigating", async function (assert) {
    const router = this.owner.lookup("service:router") as unknown as {
      transitionTo: (...a: unknown[]) => unknown;
    };
    const calls: unknown[][] = [];

    router.transitionTo = (...args: unknown[]): Promise<unknown> => {
      calls.push(args);

      return Promise.resolve();
    };

    await render(<template><DocumentDrop /></template>);

    const file = new File(["{ not json"], "bad.json", { type: "application/json" });

    fireDrag("drop", { types: ["Files"], files: [file] });

    await waitUntil(() => document.querySelector(".document-drop__error"), { timeout: 2000 });

    assert.dom(".document-drop__error").exists("parse failure is shown");
    assert.notOk(
      calls.some((c) => c[0] === "view"),
      "did not navigate on a bad file",
    );
  });
});
