import { render } from "@ember/test-helpers";
import { module, test } from "qunit";
import { setupRenderingTest } from "ember-qunit";

import IndexPage from "#app/templates/index";
import IndexLoading from "#app/templates/index-loading";
import { stubRouterTransitions } from "#test-helpers/render";

module("Integration | index-page", function (hooks) {
  setupRenderingTest(hooks);

  hooks.beforeEach(function () {
    stubRouterTransitions(this.owner);
  });

  test("the index template renders the file picker", async function (assert) {
    // The restore/redirect decision lives in the route now; the template
    // itself is just the landing page.
    await render(<template><IndexPage /></template>);

    assert.dom(".landing").exists();
    assert.dom(".landing__drop").exists("file picker is shown");
    assert.dom(".empty-state").doesNotExist();
  });

  test("the loading substate shows the restoring placeholder", async function (assert) {
    await render(<template><IndexLoading /></template>);

    assert.dom(".empty-state").includesText("Restoring previous graph");
    assert.dom(".landing__drop").doesNotExist("never the file picker while restoring");
  });
});
