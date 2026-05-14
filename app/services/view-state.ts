import Service from "@ember/service";
import { tracked } from "@glimmer/tracking";

/**
 * Single source of truth for UI state that is meaningful to remember across
 * reloads / shareable URLs:
 *
 *   e       — show edges        (1/0, default 1)
 *   h       — show cluster hulls (1/0, default 0)
 *   hidden  — comma-separated edge type ids the user has filtered out
 *   sel     — selected node id (string from the input JSON)
 *
 * The URL is the canonical representation. Reads parse `location.search`;
 * writes go through `history.replaceState`. A single `revision` tick is
 * bumped on each write so Glimmer can invalidate any getter that read this
 * service.
 *
 * This is intentionally a thin alias layer over query params — there are no
 * per-field tracked properties to keep in sync with the URL, and the URL
 * round-trips cleanly through copy/paste and the back button (well: it
 * would, if we used `pushState`; we use `replaceState` so back doesn't
 * traverse every toggle).
 *
 * Hover state, in-flight worker state, and computed counts/ticks don't
 * belong here — they're per-session and not user-meaningful.
 */
export default class ViewStateService extends Service {
  /**
   * Bumped on every write + on `popstate`. Any getter that reads this
   * becomes reactive without per-field `@tracked`. Consumers shouldn't
   * touch this directly.
   */
  @tracked private revision = 0;

  constructor(...args: ConstructorParameters<typeof Service>) {
    super(...args);
    window.addEventListener("popstate", this.onPopState);
  }

  willDestroy(): void {
    super.willDestroy();
    window.removeEventListener("popstate", this.onPopState);
  }

  private onPopState = (): void => {
    this.revision++;
  };

  // ---- raw param access

  private params(): URLSearchParams {
    // Touch the revision so this read becomes reactive — Glimmer-tracked
    // getters that delegate here re-fire when the URL changes.
    this.revision;

    return new URLSearchParams(window.location.search);
  }

  private write(mut: (p: URLSearchParams) => void): void {
    const p = new URLSearchParams(window.location.search);

    mut(p);

    const qs = p.toString();
    const url = window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;

    window.history.replaceState(null, "", url);
    this.revision++;
  }

  private setParam(key: string, value: string | null): void {
    this.write((p) => {
      if (value === null || value === "") p.delete(key);
      else p.set(key, value);
    });
  }

  // ---- typed aliases

  get showEdges(): boolean {
    return this.params().get("e") !== "0";
  }
  set showEdges(v: boolean) {
    // Default true; only encode the off state.
    this.setParam("e", v ? null : "0");
  }

  get showHulls(): boolean {
    return this.params().get("h") === "1";
  }
  set showHulls(v: boolean) {
    this.setParam("h", v ? "1" : null);
  }

  get hiddenEdgeTypes(): Set<number> {
    const raw = this.params().get("hidden");

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

    this.setParam("hidden", serialized);
  }

  /** Selected node id as it appears in the input JSON (string form), or null. */
  get selectedId(): string | null {
    const v = this.params().get("sel");

    return v && v.length > 0 ? v : null;
  }
  set selectedId(v: string | null) {
    this.setParam("sel", v);
  }
}

const EMPTY_SET: Set<number> = Object.freeze(new Set<number>()) as Set<number>;
