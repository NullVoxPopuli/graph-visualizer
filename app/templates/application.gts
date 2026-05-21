import { cleanupSSRContent } from "vite-ember-ssr/client";

import { DocumentDrop } from "#components/document-drop";
import { Header } from "#components/header.gts";

<template>
  {{cleanupSSRContent}}

  <DocumentDrop />

  <div class="app-shell">
    <Header />

    <main class="app-main">
      {{outlet}}
    </main>
  </div>
</template>
