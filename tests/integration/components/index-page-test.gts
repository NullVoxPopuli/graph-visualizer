import { render } from "@ember/test-helpers";
import { module, test } from "qunit";
import { setupRenderingTest } from "ember-qunit";

import ApplicationTemplate from "#app/templates/application";
import IndexLoading from "#app/templates/index-loading";
import AnalyzeScreen from "#components/analyze-screen";
import { stubRouterTransitions } from "#test-helpers/render";

module("Integration | app shell + analyze screen", function (hooks) {
  setupRenderingTest(hooks);

  hooks.beforeEach(function () {
    stubRouterTransitions(this.owner);
  });

  test("the header links to the analyze screen", async function (assert) {
    await render(<template><ApplicationTemplate /></template>);

    assert
      .dom("a.app-header__analyze")
      .exists("header has a link to the file/analyze screen")
      .hasText("select new analysis");
    assert
      .dom("a.app-header__analyze")
      .hasAttribute("href", "/analyze", "it points at the dedicated /analyze URL");

    // The wordmark is no longer a link.
    assert.dom(".app-header__brand").exists().hasText("Graph Visualizer");
    assert.dom("a.app-header__brand").doesNotExist("brand is not a link anymore");
  });

  test("the analyze screen renders the file picker", async function (assert) {
    await render(<template><AnalyzeScreen /></template>);

    assert.dom(".landing").exists();
    assert.dom(".landing__drop").exists("file picker is shown");
  });

  test("the loading substate shows the restoring placeholder", async function (assert) {
    await render(<template><IndexLoading /></template>);

    assert.dom(".empty-state").includesText("Restoring previous graph");
    assert.dom(".landing__drop").doesNotExist("never the file picker while restoring");
  });
});
