/**
 * This config simultaneously supports apps, libraries, typescript, etc.
 *
 * but in a way that abstracts the dependencies and configuration
 * out of your project.
 *
 * Handles: (G)TS + (G)JS, QUnit, Supporting Node files
 *          for apps and libraries
 */
import { configs } from "@nullvoxpopuli/eslint-configs";

export default [
  ...configs.ember(import.meta.dirname),
  {
    // typed-array hot paths in the renderer / layout pipeline and the UI
    // glue that reads them use `array[i]!` assertions because TS's
    // `noUncheckedIndexedAccess` widens index reads to `T | undefined`,
    // but for these contiguous buffers (and the iteration loops that
    // walk them) the indices are always in-range. Replacing them with
    // `?? 0` would obscure intent and add branches in inner loops.
    files: ["app/lib/**/*.ts", "app/components/**/*.gts", "app/services/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    // Manual memoization in service getters (visualizer pipeline,
    // cycles list) intentionally writes cache fields. `@cached` here
    // invalidates on every QP write (the reads track `router.currentRoute`),
    // forcing a worker rerun per click — the comments in these files spell
    // out why hand-rolling the memo is the right call. The "computed
    // property side-effect" rule fires on the cache writes, but the
    // pattern is deliberate and documented.
    files: ["app/services/visualizer.ts", "app/components/cycles-panel.gts"],
    rules: {
      "ember/no-side-effects": "off",
    },
  },
  {
    // Standalone Node script: runs Playwright against the test build and
    // reports pass/fail via process.exit. `playwright` is provided by the
    // CI environment, not a project dep. The script also evaluates code
    // inside the browser context, where `document` is defined.
    files: ["run-tests.mjs"],
    languageOptions: {
      globals: { document: "readonly" },
    },
    rules: {
      "n/no-missing-import": "off",
      "n/no-process-exit": "off",
    },
  },
];
