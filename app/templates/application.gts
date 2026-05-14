import { LinkTo } from "@ember/routing";

import { cleanupSSRContent } from "vite-ember-ssr/client";

<template>
  {{cleanupSSRContent}}
  <div class="app-shell">
    <header class="app-header">
      <LinkTo @route="index" class="app-header__brand">Graph Visualizer</LinkTo>
      <nav class="app-header__nav">
        <LinkTo @route="docs">JSON format</LinkTo>
      </nav>
    </header>
    <main class="app-main">
      {{outlet}}
    </main>
  </div>
</template>
