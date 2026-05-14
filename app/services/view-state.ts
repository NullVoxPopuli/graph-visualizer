import Service, { service } from "@ember/service";

import type RouterService from "@ember/routing/router-service";

// Values are strings when set, null when explicitly cleared. We keep cleared
// keys in the bag so the next `transitionTo` removes them from the URL —
// Ember leaves omitted keys alone, so a plain `delete` wouldn't actually
// strip them from `location.search`.
type QPs = Record<string, string | null>;

/**
 * Single source of truth for UI state that is meaningful to remember across
 * reloads / shareable URLs:
 *
 *   e       — show edges        (1/0, default 1)
 *   h       — show cluster hulls (1/0, default 0)
 *   hidden  — comma-separated edge type ids the user has filtered out
 *   sel     — selected node id (string from the input JSON)
 *   r       — repulsion force        (number, default 6)
 *   nd      — node distance, intra-cluster spring length  (number, default 18)
 *   cd      — cluster distance, inter-cluster spring length (number, default 180)
 *
 * Reads come from `router.currentRoute.queryParams`. Writes go through
 * `router.transitionTo({ queryParams })`, batched on rAF so a flurry of
 * rapid setters (e.g. clicking through nodes) coalesces into a single
 * transition — multiple in-flight transitions cancel each other and the
 * URL ends up out of sync with what the user actually picked.
 */
export const DEFAULT_REPULSION = 6;
export const DEFAULT_NODE_DISTANCE = 18;
export const DEFAULT_CLUSTER_DISTANCE = 180;

export default class ViewStateService extends Service {
  @service declare router: RouterService;

  // Reads merge the router's committed query params with any not-yet-flushed
  // writes from `#pending`, so two rapid toggles read the just-set value
  // instead of the (stale) value the router still has.
  get #queryParams(): QPs {
    const committed = (this.router.currentRoute?.queryParams ?? {}) as QPs;

    return this.#pending === null ? committed : { ...committed, ...this.#pending };
  }

  #frame: number | null = null;
  #pending: QPs | null = null;

  #setParam(key: string, value: string | null): void {
    const next: QPs = { ...this.#queryParams };

    next[key] = value === null || value === "" ? null : value;
    this.#pending = next;

    if (this.#frame !== null) cancelAnimationFrame(this.#frame);

    this.#frame = requestAnimationFrame(() => {
      const qps = this.#pending ?? {};

      this.#frame = null;
      this.#pending = null;
      void this.router.transitionTo({ queryParams: qps });
    });
  }

  // ---- typed aliases

  get showEdges(): boolean {
    return this.#queryParams["e"] !== "0";
  }
  set showEdges(v: boolean) {
    // Default true; only encode the off state.
    this.#setParam("e", v ? null : "0");
  }

  get showHulls(): boolean {
    return this.#queryParams["h"] === "1";
  }
  set showHulls(v: boolean) {
    this.#setParam("h", v ? "1" : null);
  }

  get hiddenEdgeTypes(): Set<number> {
    return parseIntSet(this.#queryParams["hidden"]);
  }

  toggleHiddenEdgeType(id: number): void {
    this.#setParam("hidden", serializeIntSet(toggleInSet(this.hiddenEdgeTypes, id)));
  }

  get hiddenNodeTypes(): Set<number> {
    return parseIntSet(this.#queryParams["hn"]);
  }

  toggleHiddenNodeType(id: number): void {
    this.#setParam("hn", serializeIntSet(toggleInSet(this.hiddenNodeTypes, id)));
  }

  /** Selected node id as it appears in the input JSON (string form), or null. */
  get selectedId(): string | null {
    const v = this.#queryParams["sel"];

    return v && v.length > 0 ? v : null;
  }
  set selectedId(v: string | null) {
    this.#setParam("sel", v);
  }

  /** Repulsion force fed into the d3-force charge body. */
  get repulsion(): number {
    const v = this.#queryParams["r"];
    const n = v === undefined ? NaN : Number.parseFloat(v);

    return Number.isFinite(n) ? n : DEFAULT_REPULSION;
  }
  set repulsion(n: number) {
    this.#setParam("r", n === DEFAULT_REPULSION ? null : String(n));
  }

  /** Spring length for edges that stay inside a community. */
  get nodeDistance(): number {
    const v = this.#queryParams["nd"];
    const n = v === undefined ? NaN : Number.parseFloat(v);

    return Number.isFinite(n) ? n : DEFAULT_NODE_DISTANCE;
  }
  set nodeDistance(n: number) {
    this.#setParam("nd", n === DEFAULT_NODE_DISTANCE ? null : String(n));
  }

  /** Spring length for edges that cross community boundaries. */
  get clusterDistance(): number {
    const v = this.#queryParams["cd"];
    const n = v === undefined ? NaN : Number.parseFloat(v);

    return Number.isFinite(n) ? n : DEFAULT_CLUSTER_DISTANCE;
  }
  set clusterDistance(n: number) {
    this.#setParam("cd", n === DEFAULT_CLUSTER_DISTANCE ? null : String(n));
  }
}

const EMPTY_SET: Set<number> = Object.freeze(new Set<number>()) as Set<number>;

function parseIntSet(raw: string | undefined | null): Set<number> {
  if (!raw) return EMPTY_SET;
  const out = new Set<number>();

  for (const tok of raw.split(",")) {
    const n = Number.parseInt(tok, 10);

    if (Number.isFinite(n)) out.add(n);
  }

  return out;
}

function serializeIntSet(set: Set<number>): string | null {
  if (set.size === 0) return null;

  return [...set].sort((a, b) => a - b).join(",");
}

function toggleInSet(set: Set<number>, id: number): Set<number> {
  const next = new Set(set);

  if (next.has(id)) next.delete(id);
  else next.add(id);

  return next;
}
