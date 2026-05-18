// The `index` route is a pure redirector — `routes/index.ts#beforeModel`
// always sends the visitor to `/view` (cached graph) or `/analyze` (no
// graph), with `index-loading` covering the IndexedDB restore. This
// template is only a benign fallback and is not normally shown.
<template>
  <section class="empty-state">
    <p>Restoring previous graph&hellip;</p>
  </section>
</template>
