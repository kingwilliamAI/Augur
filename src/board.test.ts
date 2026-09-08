import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";

/**
 * Starts the real board and asks it the questions a reader's browser asks.
 *
 * Every other test in this project checks a function in isolation, and on the day this file was
 * written that turned out to leave the busiest path in the product uncovered: a shadowed name inside
 * `scoreRecent` threw on first use, so the board started, logged its port, answered `/api/health`,
 * and died the moment anyone loaded the list. Nothing in the suite called `scoreRecent`, so
 * everything reported healthy while the site returned 502 for seven minutes.
 *
 * What this covers is narrow on purpose: that the process comes up, and that each route a browser
 * hits returns a body of the right shape. It does not check the numbers — the model and the log have
 * their own tests for that. Something as blunt as "does the page load" is exactly what was missing.
 */

const dir = mkdtempSync(join(tmpdir(), "augur-board-"));
/** A port unlikely to collide with a board someone is running while the tests are. */
const PORT = 4771;
const BASE = `http://127.0.0.1:${PORT}`;

let board: ChildProcess;

/**
 * The database must contain a launch, and that is the whole point.
 *
 * An empty one is not enough: with nothing in the window `scoreRecent` returns early, so the ranking
 * code never runs and the route answers 200 without having done anything. That was the first version
 * of this file, and it passed cleanly against the very bug it was written for. A smoke test that
 * exercises none of the work is worse than no smoke test, because it reports confidence it has not
 * earned.
 */
function seed(path: string): void {
  const db = openDb(path);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
    graduation_threshold_wei, graduation_threshold_eth, block, tx, log_index, ts, first_seen_at,
    enriched_at, launch_sender, creator_tax_bps, buyback_enabled, initial_buy_wei, initial_buy_eth,
    exempt_count, name, symbol, description, socials_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    TOKEN, "0xc0ffee", "0xdead", "0x0000000000000000000000000000000000000000", 1,
    "1000000000000000000", 1.0, 1000, "0xtx", 0, now - 600, now,
    now, "0xdead", 100, 0, "10000000000000000", 0.01,
    1, "Smoke", "SMOKE", "a launch for the board to rank", "{}",
  );
  db.close();
}

const TOKEN = "0x00000000000000000000000000000000000000ff";

before(async () => {
  seed(join(dir, "test.db"));
  board = spawn(process.execPath, ["--no-warnings", "src/board.ts"], {
    env: {
      ...process.env,
      BOARD_PORT: String(PORT),
      BOARD_HOST: "127.0.0.1",
      DB_PATH: join(dir, "test.db"),
      // Pinned, not inherited. The board reads this to decide whether a request arrived over TLS,
      // and a .env on the machine running the tests would otherwise change what the page says: this
      // suite passed on a laptop with no .env and failed on the server, which has TRUST_PROXY=1.
      TRUST_PROXY: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  board.stderr?.on("data", (b: Buffer) => { stderr += String(b); });

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (board.exitCode !== null) throw new Error(`board exited with ${board.exitCode}:\n${stderr}`);
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`board never answered:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 200));
  }
});

after(async () => {
  // Wait for the child to actually be gone before deleting its database.
  //
  // kill() only asks. On Windows the request and the exit are far enough apart that rmSync arrives
  // while the board still holds the file open, and a directory holding an open file cannot be
  // removed: the suite passed every assertion and then failed its own teardown with EPERM. Linux
  // unlinks an open file happily, so this only ever went red on the platform it is developed on.
  if (board && board.exitCode === null) {
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      board?.once("exit", done);
      board?.kill();
      setTimeout(done, 5_000).unref();
    });
  }
  // And the handle can outlive the process by a moment, so the removal gets a few attempts.
  for (let i = 0; ; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i >= 10) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
});

test("serves the page itself", async () => {
  const r = await fetch(BASE);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<html|<body|<!doctype/i, "that is not a page");
});

test("serves the feed", async () => {
  // The route that was broken. A 200 with a body of the right shape is the whole assertion: with an
  // empty database there is nothing to rank, and having something to rank is not what failed.
  const r = await fetch(`${BASE}/api/feed?hours=6`);
  // Read once: a Response body can only be consumed a single time, so taking it for the failure
  // message and again for the parse turns a clear assertion into a confusing one about streams.
  const body = await r.text();
  assert.equal(r.status, 200, body);
  const d = JSON.parse(body) as { items?: Array<{ token: string; probability: number }>; counts?: unknown };
  assert.ok(Array.isArray(d.items), "feed carries no items array");
  assert.ok(d.counts, "feed carries no counts");
  // The assertion that matters: the seeded launch came back scored. Without this the route can
  // answer 200 having ranked nothing, which is how the bug this file exists for slipped through.
  assert.equal(d.items?.length, 1, "the seeded launch was not ranked");
  assert.ok(typeof d.items?.[0].probability === "number", "no probability on the ranked launch");
});

test("serves the feed in both orders", async () => {
  for (const sort of ["score", "new"]) {
    const r = await fetch(`${BASE}/api/feed?hours=6&sort=${sort}`);
    const body = await r.text();
    assert.equal(r.status, 200, `sort=${sort}: ${body}`);
    const d = JSON.parse(body) as { order?: string };
    assert.equal(d.order, sort);
  }
});

test("gives a chat app something to preview, with absolute links", async () => {
  // A preview is fetched by somebody else's server, so a relative image path means nothing to it.
  // These placeholders being left in the page is the whole failure: it looks fine in a browser and
  // shows nothing in Telegram.
  const html = await (await fetch(BASE)).text();
  assert.doesNotMatch(html, /__BASE__|__TWITTER_CARD__/, "a placeholder was left unfilled");
  for (const prop of ["og:title", "og:description", "og:image", "og:url"]) {
    assert.match(html, new RegExp(`property="${prop}"`), `missing ${prop}`);
  }
  assert.match(html, /name="twitter:card" content="(summary|summary_large_image)"/);
  assert.match(html, new RegExp(`content="${BASE}/og.png"`), "og:image is not an absolute url");
});

test("takes the scheme from the proxy when there is one", async () => {
  // How it actually runs: Caddy terminates TLS and forwards plain http, so the board only knows the
  // request was secure because the proxy says so. Getting this wrong hands social networks an http
  // image url on an https page, which some of them refuse to load.
  const html = await (await fetch(BASE, { headers: { "x-forwarded-proto": "https" } })).text();
  const host = BASE.replace(/^https?:\/\//, "");
  assert.match(html, new RegExp(`content="https://${host}/og.png"`), "the proxy's scheme was ignored");
});

test("serves the preview image", async () => {
  const r = await fetch(`${BASE}/og.png`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
  // The body, not the header: the response is chunked, so content-length is absent by design.
  const bytes = new Uint8Array(await r.arrayBuffer());
  assert.ok(bytes.length > 1000, `preview image is ${bytes.length} bytes`);
  assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], "that is not a PNG");
});

test("serves the favicons, and small ones", async () => {
  // The point of cutting them: the full mark is a megabyte, fetched by every visitor to draw
  // something 32 pixels across. If these ever start returning the mark itself, that is back.
  for (const [name, ceiling] of [["icon-64.png", 40_000], ["icon-128.png", 120_000]] as const) {
    const r = await fetch(`${BASE}/${name}`);
    assert.equal(r.status, 200, name);
    assert.equal(r.headers.get("content-type"), "image/png");
    const bytes = new Uint8Array(await r.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${name} is not a PNG`);
    assert.ok(bytes.length < ceiling, `${name} is ${bytes.length} bytes, which is the full mark again`);
  }
});

test("the page points at the small icons, not the mark", async () => {
  const html = await (await fetch(BASE)).text();
  assert.match(html, /rel="icon"[^>]*href="\/icon-64\.png"/);
  assert.doesNotMatch(html, /rel="icon"[^>]*href="\/logo\.png"/, "the tab is fetching the full mark");
});

test("the model page answers, and answers faster the second time", async () => {
  // It was six seconds on the live server: a second and a half to weigh three thousand launches,
  // and five more because asking for the rows rebuilt the matrix. On a single-threaded server that
  // is six seconds nobody else is served either, paid again on every page view.
  const first = Date.now();
  const r = await fetch(`${BASE}/api/model`);
  const body = await r.text();
  assert.equal(r.status, 200, body);
  const took = Date.now() - first;

  const d = JSON.parse(body) as { importance?: unknown[]; modelId?: string };
  assert.ok(Array.isArray(d.importance), "no feature influence in the response");

  const again = Date.now();
  assert.equal((await fetch(`${BASE}/api/model`)).status, 200);
  const second = Date.now() - again;
  assert.ok(second <= Math.max(took, 50), `second call took ${second}ms against ${took}ms; the hold is not holding`);
});

test("the landing panel is not an empty frame before the feed answers", async () => {
  // The panel is the largest thing on the page and sits under a title bar that says "live". Empty,
  // it reads as broken rather than as loading, and that is the first thing a visitor sees.
  const html = await (await fetch(BASE)).text();
  const rows = html.match(/class="shot-skel"/g) ?? [];
  assert.ok(rows.length >= 5, `only ${rows.length} placeholder rows in the served page`);
});

test("the same feed is not computed twice for the same rows", async () => {
  // Ranking the window is two thirds of a second, every open tab asks for it every fifteen seconds,
  // and on one thread the fifth reader waits for the four identical answers before it.
  const first = Date.now();
  assert.equal((await fetch(`${BASE}/api/feed?hours=6`)).status, 200);
  const cold = Date.now() - first;

  const second = Date.now();
  const r = await fetch(`${BASE}/api/feed?hours=6`);
  const warm = Date.now() - second;
  assert.equal(r.status, 200);
  const d = await r.json() as { items?: unknown[] };
  assert.ok(Array.isArray(d.items), "a held answer must still be a whole answer");
  assert.ok(warm <= Math.max(cold, 50), `held answer took ${warm}ms against ${cold}ms`);
});

test("a card does not rescore the window to find its rank", async () => {
  // Where a launch stands among the window is what the feed just computed. Working it out again per
  // card was 588ms of CPU each: thirty cards took seventeen seconds, and on one thread that is the
  // whole site for seventeen seconds.
  await fetch(`${BASE}/api/feed?hours=6`);
  const first = Date.now();
  const r = await fetch(`${BASE}/api/token/${TOKEN}`);
  assert.equal(r.status, 200);
  const d = await r.json() as { score?: { rank?: number; of?: number } };
  const cold = Date.now() - first;
  assert.equal(typeof d.score?.rank, "number", "a card must still know its place");

  const second = Date.now();
  assert.equal((await fetch(`${BASE}/api/token/${TOKEN}`)).status, 200);
  assert.ok(Date.now() - second <= Math.max(cold, 60), "the second card paid for the ranking again");
});

test("reports its own health", async () => {
  const r = await fetch(`${BASE}/api/health`);
  assert.equal(r.status, 200);
  const d = await r.json() as Record<string, unknown>;
  for (const k of ["watcherSeenSecAgo", "behindBlocks", "behindSec"]) {
    assert.ok(k in d, `health is missing ${k}`);
  }
});

test("serves a card for a launch it knows", async () => {
  const r = await fetch(`${BASE}/api/token/${TOKEN}`);
  const body = await r.text();
  assert.equal(r.status, 200, body);
  const d = JSON.parse(body) as { card?: { token?: string }; score?: { probability?: number } };
  assert.equal(d.card?.token, TOKEN);
  assert.ok(typeof d.score?.probability === "number", "card came back without a score");
});

test("says not-found for a token it has never seen, rather than falling over", async () => {
  const r = await fetch(`${BASE}/api/token/0x0000000000000000000000000000000000000001`);
  assert.equal(r.status, 404);
});

test("is still standing after all of that", () => {
  assert.equal(board.exitCode, null, "the board died during the test");
});
