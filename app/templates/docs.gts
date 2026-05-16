import { LinkTo } from "@ember/routing";
import { htmlSafe, type SafeString } from "@ember/template";

import { createHighlighterCore, type HighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import json from "shiki/langs/json.mjs";
import typescript from "shiki/langs/typescript.mjs";
import githubDarkDimmed from "shiki/themes/github-dark-dimmed.mjs";

/**
 * Input shape, written as TypeScript so the type unions and optional
 * fields read naturally — the previous `{{! comment }}`-annotated
 * pseudo-schema lost its comments to the Handlebars compiler, which
 * strips `{{! ... }}` as a template comment. Putting the snippet in a
 * string constant + a real grammar (via Shiki) makes the docs reflect
 * what the parser actually accepts.
 */
const SCHEMA = `type InputGraph = {
  nodes: InputNode[];
};

type InputNode = {
  /** Unique node id. Required; numbers are coerced to strings. */
  id: string | number;
  /** Display text in the info panel. Defaults to \`id\`. */
  label?: string;
  /** Kind classifier — e.g. "package", "file", "class". */
  type?: string;
  /** Outgoing edges. */
  edges?: InputEdge[];
  /** Opaque pass-through, rendered in the info panel. */
  meta?: unknown;
};

type InputEdge =
  | string
  | number
  | { nodeId: string | number; edgeType: string };`;

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

const WITH_NODE_TYPES = `{
  "nodes": [
    {
      "id": "@acme/auth",
      "type": "package",
      "edges": ["@acme/auth/auth-service.ts", "@acme/auth/session.ts"]
    },
    {
      "id": "@acme/auth/auth-service.ts",
      "type": "file",
      "label": "@acme/auth/auth-service.ts",
      "edges": [
        { "nodeId": "@acme/auth/session.ts", "edgeType": "imports" },
        { "nodeId": "@acme/auth/types.ts",   "edgeType": "type-imports" }
      ]
    },
    { "id": "@acme/auth/session.ts", "type": "file" },
    { "id": "@acme/auth/types.ts",   "type": "file" }
  ]
}`;

/**
 * Top-level await: build the highlighter once when the docs module
 * first loads (lazy — only when the user actually visits `/docs`).
 * The output strings are baked into the template as `SafeString`s, so
 * the prerendered HTML already contains the highlighted markup and
 * the page doesn't flash through an unstyled intermediate state.
 *
 * Imports are deliberately the fine-grained `@shikijs/core` entry
 * points + individual grammar / theme modules. The default `shiki`
 * package re-exports a bundle that pulls every grammar (~hundreds of
 * KB) — going through `core` plus the JS regex engine keeps the docs
 * route under ~30 KB of additional payload.
 */
const highlighter: HighlighterCore = await createHighlighterCore({
  themes: [githubDarkDimmed],
  langs: [typescript, json],
  engine: createJavaScriptRegexEngine(),
});

function hl(code: string, lang: "typescript" | "json"): SafeString {
  return htmlSafe(
    highlighter.codeToHtml(code, {
      lang,
      theme: "github-dark-dimmed",
    }),
  );
}

const SCHEMA_HTML = hl(SCHEMA, "typescript");
const MINIMAL_HTML = hl(MINIMAL, "json");
const WITH_LABELS_HTML = hl(WITH_LABELS, "json");
const WITH_META_HTML = hl(WITH_META, "json");
const WITH_EDGE_TYPES_HTML = hl(WITH_EDGE_TYPES, "json");
const WITH_NODE_TYPES_HTML = hl(WITH_NODE_TYPES, "json");

<template>
  <article class="docs">
    <h1>JSON format</h1>
    <p>
      The visualizer reads a single JSON document with a top-level
      <code>nodes</code>
      array. Each node carries its outgoing edges as a list of target node ids. The whole file is
      read in the browser — nothing is uploaded.
    </p>

    <h2>Schema</h2>
    <div class="docs__code">{{SCHEMA_HTML}}</div>

    <h3>Fields</h3>
    <dl class="docs__dl">
      <dt><code>id</code> — required</dt>
      <dd>
        Unique identifier for the node. May be a string or number; numbers are coerced to strings
        internally. Duplicate ids cause a parse error.
      </dd>
      <dt><code>label</code> — optional</dt>
      <dd>Display text shown in the info panel when the node is selected. Defaults to
        <code>id</code>.</dd>
      <dt><code>type</code> — optional</dt>
      <dd>
        Free-form kind classifier — for example
        <code>"package"</code>,
        <code>"file"</code>,
        <code>"class"</code>. Distinct values are interned the same way edge types are, and the
        selected-node panel surfaces the type alongside id and degree counts.
      </dd>
      <dt><code>edges</code> — optional</dt>
      <dd>
        An array of outgoing edges. Each entry is either a bare target id (string or number) or an
        object
        <code>{{"{ nodeId, edgeType }"}}</code>
        where
        <code>nodeId</code>
        is the target and
        <code>edgeType</code>
        is a string label classifying the relationship (<code>"calls"</code>,
        <code>"depends-on"</code>, etc.). Both forms can be mixed in the same array. Edges
        referencing unknown ids are dropped with a console warning; duplicate
        <code>(from, to)</code>
        pairs are collapsed (first edge type wins); self-loops are dropped.
      </dd>
      <dt><code>meta</code> — optional</dt>
      <dd>
        Any user-defined object. Rendered as a key/value list in the selected node panel. Top-level
        keys with string/number/boolean values render as text; nested objects are serialized as
        JSON.
      </dd>
    </dl>

    <h2>Examples</h2>

    <h3>Minimal</h3>
    <div class="docs__code">{{MINIMAL_HTML}}</div>

    <h3>With labels</h3>
    <div class="docs__code">{{WITH_LABELS_HTML}}</div>

    <h3>With meta</h3>
    <div class="docs__code">{{WITH_META_HTML}}</div>

    <h3>With typed edges</h3>
    <div class="docs__code">{{WITH_EDGE_TYPES_HTML}}</div>

    <h3>With node types</h3>
    <div class="docs__code">{{WITH_NODE_TYPES_HTML}}</div>

    <h2>Notes</h2>
    <ul>
      <li>The graph is treated as
        <strong>directed</strong>
        —
        <code>edges</code>
        on node A pointing at node B means "A → B".</li>
      <li>Communities are computed automatically with Louvain modularity clustering.</li>
      <li>Initial positions are computed with a d3-force simulation. Layout runs in a Web Worker and
        emits ~12 batches before settling.</li>
      <li>The renderer is WebGL2-instanced; 50k+ nodes are practical on modern hardware.</li>
    </ul>

    <p>
      <LinkTo @route="index">Back to the dropzone</LinkTo>
    </p>
  </article>
</template>
