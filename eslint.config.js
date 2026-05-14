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
    // typed-array hot paths in the renderer/layout pipeline use `array[i]!`
    // assertions because TS's `noUncheckedIndexedAccess` widens them to
    // `T | undefined`, but for these contiguous buffers the indices are
    // always in-range. Replacing them with `?? 0` etc. would obscure intent
    // and add branches in inner loops.
    files: ["app/lib/**/*.ts", "app/components/visualizer.gts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
];
