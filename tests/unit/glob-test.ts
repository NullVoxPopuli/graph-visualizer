import { module, test } from "qunit";

import {
  compileGlob,
  isLabelFilteredOut,
  matchesAnyGlob,
  normalizeGlobInput,
  parseGlobs,
  serializeGlobs,
} from "#lib/glob";

module("Unit | lib/glob | compileGlob", () => {
  test("literal patterns match exactly", (assert) => {
    const re = compileGlob("foo");

    assert.true(re.test("foo"));
    assert.false(re.test("foobar"));
    assert.false(re.test("xfoo"));
  });

  test("`*` matches any run of characters (including slashes)", (assert) => {
    assert.true(compileGlob("*").test(""));
    assert.true(compileGlob("*").test("anything"));
    assert.true(compileGlob("src/*").test("src/a/b/c.ts"));
    assert.true(compileGlob("*.ts").test("nested/path/file.ts"));
  });

  test("`?` matches exactly one character", (assert) => {
    assert.true(compileGlob("?.ts").test("a.ts"));
    assert.false(compileGlob("?.ts").test("ab.ts"));
    assert.false(compileGlob("?.ts").test(".ts"));
  });

  test("regex metacharacters in the pattern are treated literally", (assert) => {
    // `.` is not a wildcard — `foo.ts` must match a literal dot.
    assert.true(compileGlob("foo.ts").test("foo.ts"));
    assert.false(compileGlob("foo.ts").test("fooxts"));

    // `(`, `)`, `+`, `{`, `}`, `[`, `]`, `\`, `^`, `$`, `|` all literal.
    assert.true(compileGlob("(a+b)").test("(a+b)"));
    assert.true(compileGlob("[x]").test("[x]"));
  });

  test("compiled regexes are cached (same instance for same pattern)", (assert) => {
    assert.strictEqual(compileGlob("foo"), compileGlob("foo"));
  });
});

module("Unit | lib/glob | matchesAnyGlob", () => {
  test("empty patterns array always returns false", (assert) => {
    assert.false(matchesAnyGlob("anything", []));
  });

  test("returns true on the first matching pattern", (assert) => {
    assert.true(matchesAnyGlob("foo.ts", ["bar*", "*.ts"]));
    assert.false(matchesAnyGlob("foo.js", ["bar*", "*.ts"]));
  });
});

module("Unit | lib/glob | isLabelFilteredOut", () => {
  test("no globs: nothing filtered", (assert) => {
    assert.false(isLabelFilteredOut("foo", [], []));
  });

  test("exclude match: filtered", (assert) => {
    assert.true(isLabelFilteredOut("foo", [], ["foo"]));
    assert.true(isLabelFilteredOut("foo.test.ts", [], ["*.test.ts"]));
  });

  test("include-only: keeps matching labels, drops others", (assert) => {
    assert.false(isLabelFilteredOut("src/foo.ts", ["src/*"], []));
    assert.true(isLabelFilteredOut("test/foo.ts", ["src/*"], []));
  });

  test("exclude wins over include", (assert) => {
    assert.true(
      isLabelFilteredOut("src/foo.test.ts", ["src/*"], ["*.test.ts"]),
      "matches include AND exclude — exclude wins",
    );
  });
});

module("Unit | lib/glob | serializeGlobs / parseGlobs", () => {
  test("empty list serializes to null (URL key gets dropped)", (assert) => {
    assert.strictEqual(serializeGlobs([]), null);
  });

  test("non-empty list uses `|` as separator", (assert) => {
    assert.strictEqual(serializeGlobs(["a"]), "a");
    assert.strictEqual(serializeGlobs(["a", "b"]), "a|b");
  });

  test("parseGlobs round-trips serializeGlobs output", (assert) => {
    assert.deepEqual(parseGlobs(null), []);
    assert.deepEqual(parseGlobs(""), []);
    assert.deepEqual(parseGlobs("a"), ["a"]);
    assert.deepEqual(parseGlobs("a|b|c"), ["a", "b", "c"]);
  });

  test("parseGlobs drops empty entries (e.g. trailing `|`)", (assert) => {
    assert.deepEqual(parseGlobs("a||b"), ["a", "b"]);
    assert.deepEqual(parseGlobs("|a|"), ["a"]);
  });
});

module("Unit | lib/glob | normalizeGlobInput", () => {
  test("returns null for empty / whitespace-only input", (assert) => {
    assert.strictEqual(normalizeGlobInput(""), null);
    assert.strictEqual(normalizeGlobInput("   "), null);
  });

  test("trims surrounding whitespace", (assert) => {
    assert.strictEqual(normalizeGlobInput("  foo  "), "foo");
  });

  test("rejects patterns containing the `|` separator", (assert) => {
    assert.strictEqual(normalizeGlobInput("a|b"), null);
  });

  test("passes through valid wildcards untouched", (assert) => {
    assert.strictEqual(normalizeGlobInput("**/*.ts"), "**/*.ts");
    assert.strictEqual(normalizeGlobInput("?-foo"), "?-foo");
  });
});
