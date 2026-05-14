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
 *   r       — repulsion force   (number, default 6)
 *   s       — spring/edge length (number, default 60)
 *
 * Reads come from `router.currentRoute.queryParams`. Writes go through
 * `router.transitionTo({ queryParams })`, batched on rAF so a flurry of
 * rapid setters (e.g. clicking through nodes) coalesces into a single
 * transition — multiple in-flight transitions cancel each other and the
 * URL ends up out of sync with what the user actually picked.
 */
export const DEFAULT_REPULSION = 6;
export const DEFAULT_SPRING_LENGTH = 60;

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
    const raw = this.#queryParams["hidden"];

    if (!raw) return EMPTY_SET;

    const out = new Set<number>();

    for (const tok of raw.split(",")) {
      const n = Number.parseInt(tok, 10);

      if (Number.isFinite(n)) out.add(n);
    }

    return out;
  }

  toggleHiddenEdgeType(id: number): void {
    const next = new Set(this.hiddenEdgeTypes);

    if (next.has(id)) next.delete(id);
    else next.add(id);
    const serialized = next.size === 0 ? null : [...next].sort((a, b) => a - b).join(",");

    this.#setParam("hidden", serialized);
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

  /** Target edge (spring) length fed into the d3-force link force. */
  get springLength(): number {
    const v = this.#queryParams["s"];
    const n = v === undefined ? NaN : Number.parseFloat(v);

    return Number.isFinite(n) ? n : DEFAULT_SPRING_LENGTH;
  }
  set springLength(n: number) {
    this.#setParam("s", n === DEFAULT_SPRING_LENGTH ? null : String(n));
  }
}

const EMPTY_SET: Set<number> = Object.freeze(new Set<number>()) as Set<number>;
