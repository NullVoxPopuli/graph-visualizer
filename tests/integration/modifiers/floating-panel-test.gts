import { render, triggerEvent } from "@ember/test-helpers";
import { module, test } from "qunit";
import { setupRenderingTest } from "ember-qunit";

import { createDragModifier, createResizeModifier } from "#lib/floating-panel";

import type { PanelGeometry } from "#lib/floating-panel";

/**
 * `#ember-testing-container` typically applies a CSS transform for
 * sandboxing, which creates a new containing block for
 * `position: fixed` descendants — so the panel's actual rendered
 * BCR is *not* the `left`/`top` inline styles we set. Reading the
 * BCR after render gives us the real starting position; from there
 * we assert on deltas rather than absolute coordinates.
 */
function panelOrigin(): { left: number; top: number; width: number; height: number } {
  const rect = document.querySelector(".test-panel")?.getBoundingClientRect();

  if (!rect) throw new Error("expected `.test-panel` in the DOM");

  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/**
 * Build a captured-geometry slot + a matching `set` callback. The
 * modifier writes through `set` on every pointermove tick during a
 * drag/resize, so the final value reflects the last move event.
 */
function captureSet(): { get: () => PanelGeometry | null; set: (g: PanelGeometry) => void } {
  let captured: PanelGeometry | null = null;

  return {
    get: () => captured,
    set: (g: PanelGeometry) => {
      captured = g;
    },
  };
}

/**
 * One PointerEvent dispatch with sensible defaults so each call site
 * only states the bits that matter to the assertion. `pointerId: 1`
 * keeps the modifier's pointer-capture tracking happy; `button: 0`
 * is the modifier's accepted left-button click.
 */
async function fire(
  selector: string,
  type: "pointerdown" | "pointermove" | "pointerup",
  point: { clientX: number; clientY: number },
  overrides: Partial<{ button: number }> = {},
): Promise<void> {
  await triggerEvent(selector, type, {
    pointerId: 1,
    button: 0,
    bubbles: true,
    cancelable: true,
    ...overrides,
    ...point,
  });
}

/**
 * `#ember-testing` ships with `transform: scale(0.5)` so the testing
 * fixture fits inside a smaller container. The transform creates a
 * new containing block for `position: fixed` descendants AND scales
 * the rendered BCR by 0.5 — `width: 500px` reads back as 250 and our
 * clientX coords from `triggerEvent` don't share the same coordinate
 * system as the rendered geometry. The drag/resize modifier's
 * `minW=200` clamp then chops down any growth that crosses the
 * pre-scale boundary. Removing the transform for these tests keeps
 * the math simple: inline `width: 400px` → BCR.width = 400, clamp
 * never triggers spuriously.
 */
function clearTestingTransform(): () => void {
  const testing = document.querySelector("#ember-testing");

  if (!(testing instanceof HTMLElement)) return (): void => {};

  const prior = testing.style.transform;

  testing.style.transform = "none";

  return (): void => {
    testing.style.transform = prior;
  };
}

module("Integration | modifier | floating-panel drag", function (hooks) {
  setupRenderingTest(hooks);

  let restore: () => void = (): void => {};

  hooks.beforeEach(function () {
    restore = clearTestingTransform();
  });
  hooks.afterEach(function () {
    restore();
  });

  test("pointerdown → pointermove → pointerup writes the new geometry through `set`", async function (assert) {
    const cap = captureSet();
    const dragMod = createDragModifier({
      panelSelector: ".test-panel",
      set: cap.set,
    });

    await render(
      <template>
        <div
          class="test-panel"
          style="position: fixed; left: 100px; top: 100px; width: 200px; height: 100px;"
        >
          <div
            class="test-drag-handle"
            style="width: 100%; height: 30px; touch-action: none;"
            {{dragMod}}
          ></div>
        </div>
      </template>,
    );

    const origin = panelOrigin();

    // Anchor inside the handle, then move by +30/+20. The modifier
    // captures the panel's BCR at pointerdown and offsets from there;
    // the absolute click coordinates don't matter as long as the
    // move's delta is +30/+20.
    await fire(".test-drag-handle", "pointerdown", {
      clientX: origin.left + 50,
      clientY: origin.top + 10,
    });
    await fire(".test-drag-handle", "pointermove", {
      clientX: origin.left + 80,
      clientY: origin.top + 30,
    });
    await fire(".test-drag-handle", "pointerup", {
      clientX: origin.left + 80,
      clientY: origin.top + 30,
    });

    const g = cap.get();

    assert.notStrictEqual(g, null, "set was called at least once");
    assert.strictEqual(g?.left, origin.left + 30, "left += 30");
    assert.strictEqual(g?.top, origin.top + 20, "top += 20");
    assert.strictEqual(g?.width, origin.width, "width preserved across the drag");
    assert.strictEqual(g?.height, origin.height, "height preserved across the drag");
  });

  test("clicking a child button on the titlebar does not start a drag", async function (assert) {
    const cap = captureSet();
    const dragMod = createDragModifier({
      panelSelector: ".test-panel",
      set: cap.set,
    });

    await render(
      <template>
        <div
          class="test-panel"
          style="position: fixed; left: 100px; top: 100px; width: 200px; height: 100px;"
        >
          <div class="test-drag-handle" style="width: 100%; height: 30px;" {{dragMod}}>
            <button type="button" class="test-close">×</button>
          </div>
        </div>
      </template>,
    );

    const origin = panelOrigin();

    // The modifier short-circuits on pointerdown when the event target
    // is (or is inside) a button/input/etc. — matches the close button
    // + section toggles inside the real titlebars.
    await fire(".test-close", "pointerdown", {
      clientX: origin.left + 50,
      clientY: origin.top + 10,
    });
    await fire(".test-drag-handle", "pointermove", {
      clientX: origin.left + 80,
      clientY: origin.top + 30,
    });
    await fire(".test-drag-handle", "pointerup", {
      clientX: origin.left + 80,
      clientY: origin.top + 30,
    });

    assert.strictEqual(cap.get(), null, "set never invoked — drag short-circuited");
  });

  test("right-click (button !== 0) is ignored", async function (assert) {
    const cap = captureSet();
    const dragMod = createDragModifier({
      panelSelector: ".test-panel",
      set: cap.set,
    });

    await render(
      <template>
        <div
          class="test-panel"
          style="position: fixed; left: 100px; top: 100px; width: 200px; height: 100px;"
        >
          <div class="test-drag-handle" style="width: 100%; height: 30px;" {{dragMod}}></div>
        </div>
      </template>,
    );

    const origin = panelOrigin();

    await fire(
      ".test-drag-handle",
      "pointerdown",
      { clientX: origin.left + 50, clientY: origin.top + 10 },
      { button: 2 },
    );
    await fire(".test-drag-handle", "pointermove", {
      clientX: origin.left + 80,
      clientY: origin.top + 30,
    });
    await fire(".test-drag-handle", "pointerup", {
      clientX: origin.left + 80,
      clientY: origin.top + 30,
    });

    assert.strictEqual(cap.get(), null, "right-click never opened a drag");
  });
});

module("Integration | modifier | floating-panel resize", function (hooks) {
  setupRenderingTest(hooks);

  let restore: () => void = (): void => {};

  hooks.beforeEach(function () {
    restore = clearTestingTransform();
  });
  hooks.afterEach(function () {
    restore();
  });

  test("east edge: pointermove right grows width, leaves height/left/top alone", async function (assert) {
    const cap = captureSet();
    const resizeMod = createResizeModifier({
      panelSelector: ".test-panel",
      edge: "e",
      set: cap.set,
    });

    await render(
      <template>
        <div
          class="test-panel"
          style="position: fixed; left: 100px; top: 100px; width: 200px; height: 100px;"
        >
          <div
            class="test-resize-handle"
            style="position: absolute; right: 0; top: 0; width: 4px; height: 100%; touch-action: none;"
            {{resizeMod}}
          ></div>
        </div>
      </template>,
    );

    const origin = panelOrigin();

    await fire(".test-resize-handle", "pointerdown", {
      clientX: origin.left + origin.width,
      clientY: origin.top + origin.height / 2,
    });
    await fire(".test-resize-handle", "pointermove", {
      clientX: origin.left + origin.width + 40,
      clientY: origin.top + origin.height / 2,
    });
    await fire(".test-resize-handle", "pointerup", {
      clientX: origin.left + origin.width + 40,
      clientY: origin.top + origin.height / 2,
    });

    const g = cap.get();

    assert.notStrictEqual(g, null);
    assert.strictEqual(g?.width, origin.width + 40, "width += 40");
    assert.strictEqual(g?.height, origin.height, "height untouched on east-only resize");
    assert.strictEqual(g?.left, origin.left, "left untouched on east-only resize");
    assert.strictEqual(g?.top, origin.top, "top untouched on east-only resize");
  });

  test("south edge: pointermove down grows height", async function (assert) {
    const cap = captureSet();
    const resizeMod = createResizeModifier({
      panelSelector: ".test-panel",
      edge: "s",
      set: cap.set,
    });

    await render(
      <template>
        <div
          class="test-panel"
          style="position: fixed; left: 100px; top: 100px; width: 200px; height: 100px;"
        >
          <div
            class="test-resize-handle"
            style="position: absolute; left: 0; bottom: 0; width: 100%; height: 4px; touch-action: none;"
            {{resizeMod}}
          ></div>
        </div>
      </template>,
    );

    const origin = panelOrigin();

    await fire(".test-resize-handle", "pointerdown", {
      clientX: origin.left + origin.width / 2,
      clientY: origin.top + origin.height,
    });
    await fire(".test-resize-handle", "pointermove", {
      clientX: origin.left + origin.width / 2,
      clientY: origin.top + origin.height + 60,
    });
    await fire(".test-resize-handle", "pointerup", {
      clientX: origin.left + origin.width / 2,
      clientY: origin.top + origin.height + 60,
    });

    const g = cap.get();

    assert.strictEqual(g?.width, origin.width, "width untouched");
    assert.strictEqual(g?.height, origin.height + 60, "height += 60");
  });

  test("south-east corner: drag down+right grows both dimensions", async function (assert) {
    const cap = captureSet();
    const resizeMod = createResizeModifier({
      panelSelector: ".test-panel",
      edge: "se",
      set: cap.set,
    });

    await render(
      <template>
        <div
          class="test-panel"
          style="position: fixed; left: 100px; top: 100px; width: 200px; height: 100px;"
        >
          <div
            class="test-resize-handle"
            style="position: absolute; right: 0; bottom: 0; width: 12px; height: 12px; touch-action: none;"
            {{resizeMod}}
          ></div>
        </div>
      </template>,
    );

    const origin = panelOrigin();

    await fire(".test-resize-handle", "pointerdown", {
      clientX: origin.left + origin.width,
      clientY: origin.top + origin.height,
    });
    await fire(".test-resize-handle", "pointermove", {
      clientX: origin.left + origin.width + 30,
      clientY: origin.top + origin.height + 40,
    });
    await fire(".test-resize-handle", "pointerup", {
      clientX: origin.left + origin.width + 30,
      clientY: origin.top + origin.height + 40,
    });

    const g = cap.get();

    assert.strictEqual(g?.width, origin.width + 30, "width += 30");
    assert.strictEqual(g?.height, origin.height + 40, "height += 40");
  });

  test("west edge: drag left moves the panel's `left` and grows width by the same amount", async function (assert) {
    const cap = captureSet();
    const resizeMod = createResizeModifier({
      panelSelector: ".test-panel",
      edge: "w",
      set: cap.set,
    });

    await render(
      <template>
        <div
          class="test-panel"
          style="position: fixed; left: 100px; top: 100px; width: 200px; height: 100px;"
        >
          <div
            class="test-resize-handle"
            style="position: absolute; left: 0; top: 0; width: 4px; height: 100%; touch-action: none;"
            {{resizeMod}}
          ></div>
        </div>
      </template>,
    );

    const origin = panelOrigin();

    // Drag the west handle left by -30: panel's `left` shrinks by 30,
    // width grows by 30 (the right edge stays put).
    await fire(".test-resize-handle", "pointerdown", {
      clientX: origin.left,
      clientY: origin.top + origin.height / 2,
    });
    await fire(".test-resize-handle", "pointermove", {
      clientX: origin.left - 30,
      clientY: origin.top + origin.height / 2,
    });
    await fire(".test-resize-handle", "pointerup", {
      clientX: origin.left - 30,
      clientY: origin.top + origin.height / 2,
    });

    const g = cap.get();

    assert.strictEqual(g?.left, origin.left - 30, "left -= 30");
    assert.strictEqual(g?.width, origin.width + 30, "width += 30 (right edge stays)");
    assert.strictEqual(g?.top, origin.top);
    assert.strictEqual(g?.height, origin.height);
  });
});
