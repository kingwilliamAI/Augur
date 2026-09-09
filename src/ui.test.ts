import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The page's own script, parsed.
 *
 * This file exists because of a bug that shipped past every other test in the suite. A helper added
 * for the traders page was called `usd`, and a function with that name was already declared eighty
 * lines above it. A duplicate `const` at the top level of a script is a SyntaxError, and a
 * SyntaxError means the browser runs none of it: no router, no feed, no card, no live pill. The page
 * still looked fine in a screenshot, because the markup around the dead script is static.
 *
 * Nothing else could have caught it. The board tests assert that routes answer, and they did; the
 * server was healthy and the HTML it served was correct. The failure was entirely in the browser.
 *
 * So: parse the script the way a browser would, and check that the pieces the router needs are all
 * actually there. It is not a substitute for opening the page, and it costs a millisecond.
 */

const HTML = readFileSync(join(import.meta.dirname, "ui", "index.html"), "utf8");

/** The one inline script at the end of the page, which is where all the behaviour lives. */
function pageScript(): string {
  const m = HTML.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
  assert.ok(m, "the page must still have its inline script at the end");
  return m![1];
}

test("the page script parses, so the browser will actually run it", () => {
  // new Function parses in the same pass a browser does: a duplicate declaration, a stray brace or a
  // reserved word throws here exactly as it would there.
  assert.doesNotThrow(() => new Function(pageScript()),
    "a SyntaxError anywhere in this script means none of the page works, however good the HTML looks");
});

test("no top-level name is declared twice", () => {
  const src = pageScript();
  const seen = new Map<string, number>();
  // Top-level only: a declaration at the start of a line with no indentation. Anything nested is in
  // its own scope and may shadow freely.
  for (const m of src.matchAll(/^(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gm)) {
    seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  }
  const dupes = [...seen].filter(([, n]) => n > 1).map(([name]) => name);
  assert.deepEqual(dupes, [], `declared more than once at the top level: ${dupes.join(", ")}`);
});

test("every page the router knows about has a section to show", () => {
  const src = pageScript();
  const m = src.match(/const PAGES = \[([^\]]+)\]/);
  assert.ok(m, "the router's page list must still be findable");
  const pages = [...m![1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
  assert.ok(pages.length >= 8, "the list should not have silently shrunk");
  for (const p of [...pages, "home"]) {
    assert.ok(HTML.includes(`id="page-${p}"`), `the router can route to "${p}" but there is no section for it`);
  }
});

test("every nav link points at a page that exists", () => {
  for (const m of HTML.matchAll(/data-nav="([a-z]+)"/g)) {
    assert.ok(HTML.includes(`id="page-${m[1]}"`), `the nav offers "${m[1]}" and nothing would open`);
  }
});

test("the ids the new pages read are all present", () => {
  // Each of these is dereferenced without a guard somewhere in the script, so a rename that misses
  // one is a null and a dead page rather than a visible error.
  for (const id of ["pv-creator", "pv-symbol", "pv-go", "pv-out", "tr-rows", "tr-msg",
    "lkconnect", "lksign", "lksentence", "wbtn"]) {
    assert.ok(HTML.includes(`id="${id}"`), `${id} is read by the script and is not in the markup`);
  }
});
