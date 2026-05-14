import { LinkTo } from "@ember/routing";

const MINIMAL = `{
  "nodes": [
    { "id": "a", "edges": ["b", "c"] },
    { "id": "b", "edges": ["c"] },
    { "id": "c" }
  ]
}`;

const WITH_LABELS = `{
  "nodes": [
    { "id": "auth", "label": "Authentication service" },
    { "id": "billing", "label": "Billing service", "edges": ["auth"] },
    { "id": "reports", "label": "Reports", "edges": ["auth", "billing"] }
  ]
}`;

const WITH_META = `{
  "nodes": [
    {
      "id": "src/index.ts",
      "label": "index.ts",
      "edges": ["src/util.ts", "src/api.ts"],
      "meta": { "lines": 142, "owner": "platform" }
    },
    {
      "id": "src/util.ts",
      "label": "util.ts",
      "meta": { "lines": 38 }
    },
    {
      "id": "src/api.ts",
      "label": "api.ts",
      "edges": ["src/util.ts"],
      "meta": { "lines": 207 }
    }
  ]
}`;

const WITH_EDGE_TYPES = `{
  "nodes": [
    {
      "id": "AuthService",
      "edges": [
        { "nodeId": "User",       "edgeType": "depends-on" },
        { "nodeId": "TokenStore", "edgeType": "depends-on" },
        { "nodeId": "Logger",     "edgeType": "calls" }
      ]
    },
    { "id": "User" },
    { "id": "TokenStore", "edges": ["Logger"] },
    { "id": "Logger" }
  ]
}`;

<template>
  <article class="docs">
    <h1>JSON format</h1>
    <p>
      The visualizer reads a single JSON document with a top-level
      <code>nodes</code> array. Each node carries its outgoing edges as a list
      of target node ids. The whole file is read in the browser &mdash; nothing
      is uploaded.
    </p>

    <h2>Schema</h2>
    <pre class="docs__pre">
{{"{"}}
  "nodes": [
    {{"{"}}
      "id":    string | number,   {{!-- required, must be unique --}}
      "label": string,            {{!-- optional, defaults to `id` --}}
      "edges": Edge[],            {{!-- optional, outgoing edges (see below) --}}
      "meta":  any                {{!-- optional, opaque pass-through --}}
    {{"}"}}, ...
  ]
{{"}"}}

type Edge =
  | string | number                            {{!-- bare target id --}}
  | {{"{"}} "nodeId": string | number,
      "edgeType": string {{"}"}}                       {{!-- typed edge --}}</pre>

    <h3>Fields</h3>
    <dl class="docs__dl">
      <dt><code>id</code> &mdash; required</dt>
      <dd>
        Unique identifier for the node. May be a string or number; numbers are
        coerced to strings internally. Duplicate ids cause a parse error.
      </dd>
      <dt><code>label</code> &mdash; optional</dt>
      <dd>Display text shown in the info panel when the node is selected. Defaults to <code>id</code>.</dd>
      <dt><code>edges</code> &mdash; optional</dt>
      <dd>
        An array of outgoing edges. Each entry is either a bare target id
        (string or number) or an object <code>{{"{ nodeId, edgeType }"}}</code>
        where <code>nodeId</code> is the target and <code>edgeType</code> is a
        string label classifying the relationship (<code>&quot;calls&quot;</code>,
        <code>&quot;depends-on&quot;</code>, etc.). Both forms can be mixed in
        the same array. Edges referencing unknown ids are dropped with a
        console warning; duplicate <code>(from, to)</code> pairs are collapsed
        (first edge type wins); self-loops are dropped.
      </dd>
      <dt><code>meta</code> &mdash; optional</dt>
      <dd>
        Any user-defined object. Rendered as a key/value list in the selected
        node panel. Top-level keys with string/number/boolean values render as
        text; nested objects are serialized as JSON.
      </dd>
    </dl>

    <h2>Examples</h2>

    <h3>Minimal</h3>
    <pre class="docs__pre">{{MINIMAL}}</pre>

    <h3>With labels</h3>
    <pre class="docs__pre">{{WITH_LABELS}}</pre>

    <h3>With meta</h3>
    <pre class="docs__pre">{{WITH_META}}</pre>

    <h3>With typed edges</h3>
    <pre class="docs__pre">{{WITH_EDGE_TYPES}}</pre>

    <h2>Notes</h2>
    <ul>
      <li>The graph is treated as <strong>directed</strong> &mdash; <code>edges</code> on node A pointing at node B means &quot;A → B&quot;.</li>
      <li>Communities are computed automatically with Louvain modularity clustering.</li>
      <li>Initial positions are computed with a d3-force simulation. Layout runs in a Web Worker and emits ~12 batches before settling.</li>
      <li>The renderer is WebGL2-instanced; 50k+ nodes are practical on modern hardware.</li>
    </ul>

    <p>
      <LinkTo @route="index">Back to the dropzone</LinkTo>
    </p>
  </article>
</template>
