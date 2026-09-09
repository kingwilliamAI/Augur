import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The four rules that decide whether a wallet has a record, driven against a database built to
 * break them.
 *
 * Every test here is somebody trying to manufacture a record, because that is the only threat this
 * module exists to answer. A graduation rate is trivial to fake if entries on your own launches
 * count, or if entries on a launch that waived the opening tax for you count, or if buying a token
 * nobody else touched counts, or if ten entries across two friendly creators count. Each of those is
 * a test, and each of them fails against a version of this module without the matching rule.
 */

const dir = mkdtempSync(join(tmpdir(), "augur-traders-"));
process.env.DB_PATH = join(dir, "test.db");

const { openDb } = await import("./db.ts");
const T = await import("./traders.ts");

const db = openDb();
const T0 = 1_800_000_000;
const ZERO = "0x0000000000000000000000000000000000000000";
const wallet = (n: number): string => `0x${String(n).padStart(40, "0")}`;

const TRADER = wallet(1);
const FAKER = wallet(2);
let block = 1000;

function launch(token: string, creator: string, opts: { exempt?: string[] } = {}): number {
  const b = block += 10;
  db.prepare(`INSERT INTO launches
    (token, curve, deployer, pair_token, launch_config_id, graduation_threshold_wei,
     graduation_threshold_eth, block, tx, log_index, ts, launch_sender, symbol, first_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    token, `${token}c`, creator, ZERO, 1, "1000", 1, b, `0x${b}`, 0, T0, creator, token.slice(2, 8), T0);
  for (const a of opts.exempt ?? []) {
    db.prepare("INSERT INTO exemptions (token, address) VALUES (?,?)").run(token, a);
  }
  // Every curve counts as read, which is what the base rate is measured over.
  db.prepare("INSERT INTO curve_indexed (token, to_block, trades, indexed_at) VALUES (?,?,?,?)")
    .run(token, b + 500, 2, T0);
  return b;
}

let logIndex = 0;
function buy(token: string, who: string, atBlock: number, quote: number, tokens = 1000): void {
  db.prepare(`INSERT INTO curve_trades
    (token, tx, log_index, side, actor, recipient, quote_wei, quote_eth, token_amt, fee_wei, tax_wei, tax_eth, block, ts)
    VALUES (?,?,?,'buy',?,?,?,?,?,'0','0',0,?,0)`).run(
    token, `0xt${logIndex}`, logIndex++, who, who, String(quote), quote / 1e18, String(tokens), atBlock);
}

const graduate = (token: string): void => {
  db.prepare(`INSERT INTO graduations (token, block, tx, ts, position_id, token_amount, pair_wei, pair_eth)
    VALUES (?,?,?,?,?,?,?,?)`).run(token, block += 5, `0xg${token}`, T0 + 300, "1", "1", "1", 1);
};

/** A clean entry: somebody else's launch, real other volume, bought after the launch block. */
function cleanEntry(token: string, creator: string, buyer: string, graduated: boolean): void {
  const b = launch(token, creator);
  buy(token, wallet(99), b + 1, 5e18, 900);
  buy(token, buyer, b + 2, 1e18, 1000);
  buy(token, wallet(98), b + 3, 5e18, 800);
  if (graduated) graduate(token);
}

/**
 * A read set to be measured against.
 *
 * Four hundred curves read here, one in twenty of which graduated. Without a pool this size there is
 * no base rate at all, which is deliberate: a record is a comparison, and a comparison against
 * thirty curves is a number that moves when one of them graduates.
 */
for (let i = 0; i < 400; i++) {
  const b = launch(`0xseed${i}`, wallet(500 + i));
  buy(`0xseed${i}`, wallet(600 + (i % 20)), b + 2, 1e18, 1000);
  if (i % 20 === 0) graduate(`0xseed${i}`);
}

test("a lucky handful is not a record, however good it looks", () => {
  for (let i = 0; i < 3; i++) cleanEntry(`0xluck${i}`, wallet(10 + i), TRADER, true);
  const rec = T.traderRecord(db, TRADER);
  assert.equal(rec.entries, 3);
  assert.equal(rec.graduated, 3);
  assert.equal(rec.rate, 1, "three out of three");
  assert.equal(rec.qualifies, false);
  assert.match(rec.short, /3 clean entries/);
});

test("entries on your own launches do not count", () => {
  for (let i = 0; i < 12; i++) {
    const b = launch(`0xmine${i}`, FAKER);
    buy(`0xmine${i}`, wallet(50), b + 1, 1e18, 500);
    buy(`0xmine${i}`, FAKER, b + 2, 1e18, 1000);
    graduate(`0xmine${i}`);
  }
  const rec = T.traderRecord(db, FAKER);
  assert.equal(rec.entries, 0, "twelve graduations, every one of them on a launch they made");
  assert.equal(rec.excluded.own, 12);
  assert.equal(rec.qualifies, false);
});

test("an entry the creator waived the opening tax for does not count", () => {
  const friend = wallet(3);
  for (let i = 0; i < 12; i++) {
    const b = launch(`0xex${i}`, wallet(20 + i), { exempt: [friend] });
    buy(`0xex${i}`, wallet(50), b + 1, 5e18, 500);
    buy(`0xex${i}`, friend, b + 2, 1e18, 1000);
    graduate(`0xex${i}`);
  }
  const rec = T.traderRecord(db, friend);
  assert.equal(rec.entries, 0, "the exempt list is the creator naming their own people, on chain");
  assert.equal(rec.excluded.exempt, 12);
});

test("a token you were the whole market for does not count", () => {
  const pumper = wallet(4);
  for (let i = 0; i < 12; i++) {
    const b = launch(`0xsolo${i}`, wallet(40 + i));
    buy(`0xsolo${i}`, pumper, b + 2, 9e18, 5000);
    buy(`0xsolo${i}`, wallet(51), b + 3, 1e17, 50);
    graduate(`0xsolo${i}`);
  }
  const rec = T.traderRecord(db, pumper);
  assert.equal(rec.entries, 0, "ninety-eight percent of the buy volume was their own");
  assert.equal(rec.excluded.ownMarket, 12);
});

test("ten entries across two friendly creators is not a record either", () => {
  const pair = wallet(5);
  for (let i = 0; i < 12; i++) cleanEntry(`0xpair${i}`, wallet(i % 2 === 0 ? 60 : 61), pair, true);
  const rec = T.traderRecord(db, pair);
  assert.equal(rec.entries, 12);
  assert.equal(rec.creators, 2);
  assert.equal(rec.qualifies, false, "two wallets taking turns pass every other rule");
  assert.match(rec.short, /creators/);
});

test("one creator supplying most of the entries is not a record", () => {
  const leaner = wallet(6);
  for (let i = 0; i < 8; i++) cleanEntry(`0xlean${i}`, wallet(70), leaner, true);
  for (let i = 0; i < 5; i++) cleanEntry(`0xlean1${i}`, wallet(71 + i), leaner, true);
  const rec = T.traderRecord(db, leaner);
  assert.equal(rec.creators, 6);
  assert.ok(rec.topCreatorShare > 0.4);
  assert.equal(rec.qualifies, false);
  assert.match(rec.short, /one creator/);
});

test("a spread record that beats the pool it picked from clears the bar", () => {
  const real = wallet(7);
  for (let i = 0; i < 25; i++) cleanEntry(`0xreal${i}`, wallet(100 + i), real, i < 12);
  const rec = T.traderRecord(db, real);
  assert.equal(rec.entries, 25);
  assert.equal(rec.graduated, 12);
  assert.equal(rec.creators, 25);
  assert.ok(rec.base !== null && rec.base < (rec.rate ?? 0), "the read set graduates less often than this wallet");
  assert.ok(rec.lower !== null && rec.lower < (rec.rate ?? 0), "the bound sits below the raw rate");
  assert.ok(rec.lift !== null && rec.lift > 1);
  assert.equal(rec.qualifies, true, rec.short);
  assert.ok(rec.medianMultiple !== null && rec.medianMultiple > 1, "their entries ran above where they got in");
});

test("the bound is what keeps a small sample from outranking a long one", () => {
  assert.ok(T.wilsonLower(3, 3) < T.wilsonLower(40, 50),
    "three out of three is 100% and 40 out of 50 is 80%; the second is the better record");
  assert.equal(T.wilsonLower(0, 0), 0, "nothing to go on is not a rate");
  assert.ok(T.wilsonLower(1, 100) > 0);
});

test("a wallet that only ever bought its own launches reads as excluded, not as a bad trader", () => {
  const rec = T.traderRecord(db, FAKER);
  assert.equal(rec.rate, null, "no clean entries is not a 0% record");
  assert.ok(rec.excluded.own > 0);
});

test("the base rate is the read set, not the chain", () => {
  const base = T.readBaseRate(db);
  assert.ok(base !== null);
  assert.equal(base.n, (db.prepare("SELECT count(*) c FROM curve_indexed").get() as { c: number }).c);
  assert.ok(base.rate > 0.02,
    `curves are read because somebody looked at them, so the read set graduates far more often `
    + `than the chain's two percent: ${base.rate}`);
});

test("teardown", () => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
