/**
 * Tiny glob matcher. Supports two wildcards:
 *
 *   `*` — any run of characters (including `/`, since labels are
 *         often path-like — `src/*` should match `src/a/b/c.ts`)
 *   `?` — a single character
 *
 * Every other character is matched literally. Other special characters
 * (regex metacharacters, brace expansion, character classes, `!`
 * negation) are NOT supported — we have separate include/exclude
 * lists, so the user expresses negation by listing a pattern in
 * `excludeGlobs` instead of prefixing with `!`.
 *
 * Patterns are compiled once and cached so a repeated render pass
 * doesn't pay the cost of re-walking the same string.
 */
const cache = new Map<string, RegExp>();

export function compileGlob(pattern: string): RegExp {
  const cached = cache.get(pattern);

  if (cached) return cached;

  let out = "^";

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;

    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else if (/[\\^$.+(){}[\]|]/.test(ch)) out += `\\${ch}`;
    else out += ch;
  }

  out += "$";

  const re = new RegExp(out);

  cache.set(pattern, re);

  return re;
}

/**
 * True when `label` matches at least one pattern in `patterns`. An
 * empty patterns array returns `false` — callers wanting "no filter
 * means everything passes" handle that explicitly.
 */
export function matchesAnyGlob(label: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (compileGlob(p).test(label)) return true;
  }

  return false;
}

/**
 * Decide whether a label is *hidden* by the include/exclude lists.
 * Semantics:
 *
 *   - With no patterns at all, nothing is hidden (everything passes).
 *   - `excludeGlobs` always wins: a label that matches any exclude is
 *     hidden, even if it also matches an include.
 *   - When `includeGlobs` is non-empty, a label that matches *none*
 *     of the includes is hidden too. An empty include list means
 *     "include everything by default."
 */
export function isLabelFilteredOut(
  label: string,
  includeGlobs: readonly string[],
  excludeGlobs: readonly string[],
): boolean {
  if (excludeGlobs.length > 0 && matchesAnyGlob(label, excludeGlobs)) return true;
  if (includeGlobs.length > 0 && !matchesAnyGlob(label, includeGlobs)) return true;

  return false;
}

const GLOB_SEPARATOR = "|";

/**
 * URL encoding for a glob list. We use `|` as the separator — globs
 * accept `*`, `?`, `/`, `.`, and assorted path / identifier characters,
 * but a literal `|` is unusual enough that this is the least-friction
 * choice. A pattern containing `|` cannot round-trip through this
 * encoding; the add path rejects such inputs.
 */
export function serializeGlobs(globs: readonly string[]): string | null {
  if (globs.length === 0) return null;

  return globs.join(GLOB_SEPARATOR);
}

export function parseGlobs(raw: string | null | undefined): string[] {
  if (!raw) return [];

  return raw.split(GLOB_SEPARATOR).filter((s) => s.length > 0);
}

/**
 * Reject `|` (the URL separator) and surrounding whitespace; everything
 * else passes through as written. Returns `null` when the input has no
 * usable characters left.
 */
export function normalizeGlobInput(raw: string): string | null {
  const trimmed = raw.trim();

  if (trimmed.length === 0) return null;
  if (trimmed.includes(GLOB_SEPARATOR)) return null;

  return trimmed;
}
