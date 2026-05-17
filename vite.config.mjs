import { defineConfig } from "vite";
import { extensions, ember } from "@embroider/vite";
import { emberSsg } from "vite-ember-ssr/vite-plugin";
import { babel } from "@rollup/plugin-babel";
import Icons from "unplugin-icons/vite";

export default defineConfig({
  plugins: [
    ember(),
    Icons({ compiler: "ember" }),
    emberSsg({
      routes: ["index", "docs"],
      ssrEntry: "app/app-ssr.ts",
    }),
    babel({
      babelHelpers: "runtime",
      extensions,
    }),
  ],
  // Pre-bundle worker deps so the workers (`app/lib/analyze.worker.ts` +
  // `app/lib/layout.worker.ts`) hit stable cached URLs. Without this, Vite
  // can re-optimize deps on the fly when it sees a new import on the main
  // thread, invalidating the `?v=hash` query string the workers are still
  // pointing at — the worker then 504s and never starts.
  optimizeDeps: {
    include: [
      "comlink",
      "flatbush",
      "graphology",
      "graphology-communities-louvain",
      "d3-force",
      "d3-polygon",
      "d3-selection",
      "d3-zoom",
    ],
  },
  worker: {
    format: "es",
  },
});
