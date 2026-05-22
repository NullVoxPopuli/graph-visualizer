import { module, test } from "qunit";
import { setupTest } from "ember-qunit";

import type VisualizerService from "#services/visualizer";

function visualizer(owner: { lookup(name: string): unknown }): VisualizerService {
  return owner.lookup("service:visualizer") as VisualizerService;
}

module("Integration | service:visualizer | pendingFocus", function (hooks) {
  setupTest(hooks);

  test("focusOnId queues a plain recenter (no zoomIn flag)", function (assert) {
    const vis = visualizer(this.owner);

    assert.strictEqual(vis.pendingFocus, null, "starts empty");

    vis.focusOnId("alpha");

    assert.ok(vis.pendingFocus, "request queued");
    assert.strictEqual(vis.pendingFocus?.id, "alpha", "carries the id");
    assert.notOk(vis.pendingFocus?.zoomIn, "no zoomIn flag on plain focus");
  });

  test("zoomInOnId sets the zoomIn flag so the camera animates a tighter view", function (assert) {
    const vis = visualizer(this.owner);

    vis.zoomInOnId("beta");

    assert.strictEqual(vis.pendingFocus?.id, "beta", "carries the id");
    assert.true(vis.pendingFocus?.zoomIn, "zoomIn flag set");
  });

  test("each call refreshes the timestamp so the rAF loop treats it as a new request", async function (assert) {
    const vis = visualizer(this.owner);

    vis.focusOnId("a");

    const firstTs = vis.pendingFocus?.ts ?? 0;

    // Tick the clock past the millisecond boundary so the timestamp can move.
    await new Promise<void>((res) => setTimeout(res, 2));

    vis.zoomInOnId("b");

    const secondTs = vis.pendingFocus?.ts ?? 0;

    assert.ok(secondTs > firstTs, "timestamp advances between calls");
  });
});
