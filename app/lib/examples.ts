/**
 * Manifest of example graphs served from `public/examples/`. Used by the
 * landing page (and any other route that wants to surface example links) to
 * render a consistent list of clickable examples.
 */
export interface Example {
  label: string;
  description: string;
  /** URL relative to the site root. */
  url: string;
}

export const EXAMPLES: Example[] = [
  {
    label: "minimal",
    description: "10 nodes, hand-built, two clusters",
    url: "/examples/minimal.json",
  },
  {
    label: "typed edges",
    description: "7 services, depends-on / calls / owns / references",
    url: "/examples/typed-edges.json",
  },
  {
    label: "monorepo",
    description: "7 packages, ~10 files each · package / file types, imports / type-imports / re-exports",
    url: "/examples/monorepo.json",
  },
  {
    label: "medium",
    description: "200 nodes · 5 clusters, generated",
    url: "/examples/medium.json",
  },
  {
    label: "large",
    description: "5,000 nodes · 8 clusters, generated",
    url: "/examples/large.json",
  },
];
