import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Watching a launch for arrivals.
 *
 * The rule that matters here is where watching starts. Everyone who ever bought is history and the
 * alert is meant to be a warning, so a list that began at the launch block would open with a burst
 * of names from hours ago, all of them reading as though they had just happened. The second rule is
 * that a graduated launch stops being watchable at all: its curve goes quiet, and a watch that can
 * never fire again is worse than a refusal, because it looks like it is working.
 */

const dir = mkdtempSync(join(tmpdir(), "augur-tracks-"));
process.env.DB_PATH = join(dir, "test.db");

const { openDb } = await import("./db.ts");
const K = await import("./tracks.ts");

const db = openDb();
const T0 = 1_800_000_000;
const ZERO = "0x0000000000000000000000000000000000000000";
const TOKEN = "0xaaaa000000000000000000000000000000000001";
const GRADUATED = "0xaaaa000000000000000000000000000000000002";
const EARLY = "0xb000000000000000000000000000000000000001";
const LATE = "0xb000000000000000000000000000000000000002";

function launch(token: string, block: number): void {
  db.prepare(`INSERT INTO launches
    (token, curve, deployer, pair_token, launch_config_id, graduation_threshold_wei,
     graduation_threshold_eth, block, tx, log_index, ts, launch_sender, symbol, first_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    token, `${token}c`, ZERO, ZERO, 1, "1000", 1, block, `0x${block}`, 0, T0, ZERO, "SYM", T0);
}

let li = 0;
const buy = (token: string, who: string, block: number, quote: number): void => {
  db.prepare(`INSERT INTO curve_trades
    (token, tx, log_index, side, actor, recipient, quote_wei, quote_eth, token_amt, fee_wei, tax_wei, tax_eth, block, ts)
    VALUES (?,?,?,'buy',?,?,?,?,?,'0','0',0,?,0)`).run(
    token, `0x${li}`, li++, who, who, String(quote), quote / 1e18, "1000", block);
};

launch(TOKEN, 1000);
launch(GRADUATED, 900);
db.prepare(`INSERT INTO graduations (token, block, tx, ts, position_id, token_amount, pair_wei, pair_eth)
  VALUES (?,?,?,?,?,?,?,?)`).run(GRADUATED, 950, "0xg", T0, "1", "1", "1", 1);

test("a launch that has reached the pool cannot be watched", () => {
  assert.deepEqual(K.track(db, 1, GRADUATED, 1200, T0, 2),
    { ok: false, reason: "closed", count: 0 },
    "its curve has stopped trading, so accepting this would promise alerts that cannot happen");
});

test("a launch nobody has heard of is refused rather than watched blindly", () => {
  const res = K.track(db, 1, "0xdead000000000000000000000000000000000000", 1200, T0, 2);
  assert.deepEqual(res, { ok: false, reason: "unknown", count: 0 });
});

test("watching starts at the block it was asked at, not at the launch", () => {
  buy(TOKEN, EARLY, 1010, 3e18);
  assert.deepEqual(K.track(db, 1, TOKEN, 1200, T0, 2), { ok: true, count: 1 });
  buy(TOKEN, LATE, 1300, 2e18);

  const buyers = K.newBuyers(db, 1, TOKEN, 1200);
  assert.deepEqual(buyers.map((b) => b.address), [LATE],
    "the wallet that was already in is history, and history reads as news in an alert");
});

test("a wallet is named once, however many times it buys", () => {
  buy(TOKEN, LATE, 1310, 1e18);
  const before = K.newBuyers(db, 1, TOKEN, 1200);
  assert.equal(before.length, 1);
  assert.equal(before[0].quote, 3e18, "both of their buys, added up");

  K.markTraderSent(db, 1, TOKEN, LATE, T0);
  assert.deepEqual(K.newBuyers(db, 1, TOKEN, 1200), [], "already named");
});

test("two chats watching the same launch cost one read between them", () => {
  K.track(db, 2, TOKEN, 1400, T0, 2);
  const tokens = K.trackedTokens(db);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].fromBlock, 1200, "the earliest of the two, so neither is short-changed");
  assert.deepEqual(K.watchersOf(db, TOKEN).map((w) => w.chat_id).sort(), [1, 2]);
});

test("the later watcher does not inherit the earlier one's arrivals", () => {
  assert.deepEqual(K.newBuyers(db, 2, TOKEN, 1400), [],
    "everything on this curve happened before chat 2 asked");
});

test("the cap is per chat, and a second ask is not a second row", () => {
  launch("0xcccc000000000000000000000000000000000001", 1100);
  assert.deepEqual(K.track(db, 1, TOKEN, 1500, T0, 2), { ok: false, reason: "already", count: 1 });
  assert.deepEqual(K.track(db, 1, "0xcccc000000000000000000000000000000000001", 1500, T0, 2), { ok: true, count: 2 });
  launch("0xcccc000000000000000000000000000000000002", 1100);
  assert.deepEqual(K.track(db, 1, "0xcccc000000000000000000000000000000000002", 1500, T0, 2),
    { ok: false, reason: "full", count: 2 });
});

test("graduating retires the watch for everybody at once, and says who to tell", () => {
  const told = K.retireGraduated(db, TOKEN);
  assert.deepEqual(told.sort(), [1, 2]);
  assert.equal(K.trackedTokens(db).some((t) => t.token === TOKEN), false);
  assert.equal(K.watchersOf(db, TOKEN).length, 0);
  assert.equal((db.prepare("SELECT count(*) c FROM tg_trader_sent WHERE token = ?").get(TOKEN) as { c: number }).c, 0,
    "the record of who was named goes with the watch it belonged to");
});

test("untracking forgets the names too, so watching again starts clean", () => {
  K.markTraderSent(db, 1, "0xcccc000000000000000000000000000000000001", LATE, T0);
  assert.equal(K.untrack(db, 1, "0xcccc000000000000000000000000000000000001"), true);
  assert.equal((db.prepare("SELECT count(*) c FROM tg_trader_sent WHERE chat_id = 1").get() as { c: number }).c, 0);
  assert.equal(K.untrack(db, 1, "0xcccc000000000000000000000000000000000001"), false);
});

test("teardown", () => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
