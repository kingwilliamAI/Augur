import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { earlyFeatures, outcomes, windowBlocks } from "./early.ts";
import {
  candidates, confirm, matches, membership, permutationNull, search, TARGETS, type Condition,
} from "./patterns.ts";
import type { Early } from "./early.ts";

/**
 * A pattern search fails in one direction only: it finds things. Everything here guards the two ways
 * a found thing turns out to be nothing — a target that contains the evidence, and a search wide
 * enough that its best result is a lottery win — because neither leaves a trace in the output. Both
 * were live in the first version of this search: it opened by announcing that launches already up
 * 3.8x in their first thirty seconds tend to reach 5x.
 */

const blank = (over: Partial<Early> = {}): Early => ({
  token: "t", trades: 0, buys: 0, sells: 0, buyers: 0, sellers: 0, buyVolume: 0, sellVolume: 0,
  priceMove: 1, topBuyShare: 0, buysPerBuyer: 0, creatorSold: 0, snipers: 0, blocksToCrowd: 0,
  sellPressure: 0, ...over,
});

test("the forward target cannot see inside the window it is measured from", () => {
  // The tautology this whole file exists to prevent. A token that runs hard inside the window and
  // then dies must score zero on the forward target, however spectacular the window looked.
  const db = openDb(":memory:");
  const at = 30;
  const width = windowBlocks(at);
  const ins = db.prepare(`INSERT INTO launches
    (token, curve, deployer, pair_token, launch_config_id, graduation_threshold_wei,
     graduation_threshold_eth, block, tx, log_index, ts, first_seen_at)
    VALUES (?,?,?,?,0,'0',0,?,?,0,?,?)`);
  const trade = db.prepare(`INSERT INTO curve_trades
    (token, tx, log_index, side, actor, recipient, quote_wei, quote_eth, token_amt,
     fee_wei, tax_wei, tax_eth, block, ts) VALUES (?,?,?,'buy','0xa','0xa',?,0,?, '0','0',0,?,0)`);

  // Priced in whole units of 1: quote_wei over token_amt is the price.
  const put = (name: string, prices: Array<[block: number, price: number]>): void => {
    const token = `0x${name}`;
    ins.run(token, "0xc", "0xd", "0x0", 1000, `0xtx${name}`, 1_700_000_000, 1_700_000_000);
    prices.forEach(([block, price], i) =>
      trade.run(token, `0x${name}${i}`, i, String(price * 1e6), "1000000", 1000 + block));
  };

  // Runs 5x inside the window, then never trades higher again.
  put("aa", [[0, 1], [5, 3], [width - 1, 5], [width + 50, 4], [width + 90, 2]]);
  // Flat inside the window, then triples afterwards.
  put("bb", [[0, 1], [5, 1], [width - 1, 1], [width + 50, 3], [width + 90, 2]]);

  const out = outcomes(db, at);
  const aa = out.get("0xaa") as never as { peak: number; peakAfter: number };
  const bb = out.get("0xbb") as never as { peak: number; peakAfter: number };

  assert.ok(aa.peak >= 5, "its lifetime peak really was 5x");
  assert.ok(aa.peakAfter < 1.01, "but nothing was left to capture, so the forward target says so");
  assert.ok(bb.peakAfter >= 2.9, "the one that moved afterwards is the one that scores");
  assert.ok(TARGETS.x3.of(bb as never) === 1 && TARGETS.x3.of(aa as never) === 0);
  db.close();
});

test("early features stop at the window and do not read past it", () => {
  const db = openDb(":memory:");
  const at = 10;
  const width = windowBlocks(at);
  db.prepare(`INSERT INTO launches
    (token, curve, deployer, pair_token, launch_config_id, graduation_threshold_wei,
     graduation_threshold_eth, block, tx, log_index, ts, first_seen_at, launch_sender)
    VALUES ('0xt','0xc','0xd','0x0',0,'0',0,1000,'0xtx',0,1700000000,1700000000,'0xcreator')`).run();
  const trade = db.prepare(`INSERT INTO curve_trades
    (token, tx, log_index, side, actor, recipient, quote_wei, quote_eth, token_amt,
     fee_wei, tax_wei, tax_eth, block, ts) VALUES ('0xt',?,?,?,?,?,'1000000',0,'1000000','0','0',0,?,0)`);

  trade.run("0x1", 0, "buy", "0xa", "0xa", 1000 + width - 1);
  trade.run("0x2", 1, "buy", "0xb", "0xb", 1000 + width);
  // Everything below is past the window and must be invisible.
  trade.run("0x3", 2, "buy", "0xc", "0xc", 1000 + width + 1);
  trade.run("0x4", 3, "sell", "0xcreator", "0xcreator", 1000 + width + 2);

  const e = earlyFeatures(db, at).get("0xt") as Early;
  assert.equal(e.buys, 2, "the buy one block past the window is not in the window");
  assert.equal(e.buyers, 2);
  assert.equal(e.creatorSold, 0, "the creator sold after the window, which we are not allowed to know");
  db.close();
});

test("a search over enough conditions finds a pattern in pure noise", () => {
  // The premise of the permutation null, asserted rather than assumed: with labels that have nothing
  // to do with the features, the *best* candidate still lands well above the base rate. Anything
  // that does not clear this line is not a finding.
  let seed = 12345;
  const rand = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const rows = Array.from({ length: 1200 }, () =>
    blank({ buys: Math.floor(rand() * 50), buyers: Math.floor(rand() * 30), snipers: Math.floor(rand() * 8) }));
  const labels = Float64Array.from(rows, () => (rand() < 0.05 ? 1 : 0));

  const conds = candidates(rows);
  const members = membership(rows, conds);
  const found = search(rows, labels, conds, members, 40);
  assert.ok(found.verdicts[0].lift > 1.5, "the best of a wide search on noise still looks like a signal");

  const noise = permutationNull(rows, labels, conds, members, 40, 40);
  assert.ok(noise.p95 >= found.verdicts[0].lift * 0.7, "and the null knows it, so the finding does not clear it");
});

test("the permutation null is seeded, so a quoted number stays quoted", () => {
  const rows = Array.from({ length: 400 }, (_, i) => blank({ buys: i % 37, snipers: i % 9 }));
  const labels = Float64Array.from(rows, (_, i) => (i % 11 === 0 ? 1 : 0));
  const conds = candidates(rows);
  const members = membership(rows, conds);
  const a = permutationNull(rows, labels, conds, members, 30, 20);
  const b = permutationNull(rows, labels, conds, members, 30, 20);
  assert.equal(a.p95, b.p95);
});

test("a pattern is judged on rows it had no part in choosing", () => {
  const cond: Condition = { field: "snipers", op: ">=", value: 6 };
  const pattern = { conditions: [cond] };
  const holdout = [blank({ snipers: 7 }), blank({ snipers: 7 }), blank({ snipers: 1 }), blank({ snipers: 0 })];
  const v = confirm(pattern, holdout, Float64Array.from([1, 1, 0, 0]));
  assert.equal(v.n, 2, "only the rows the pattern actually selects");
  assert.equal(v.rate, 1);
  assert.equal(v.lift, 2, "against the base rate of the set that judged it, not of the set that proposed it");
});

test("a conjunction means both halves, not either", () => {
  const p = { conditions: [
    { field: "snipers", op: ">=", value: 6 } as Condition,
    { field: "topBuyShare", op: "<=", value: 0.1 } as Condition,
  ] };
  assert.ok(matches(p, blank({ snipers: 8, topBuyShare: 0.05 })));
  assert.ok(!matches(p, blank({ snipers: 8, topBuyShare: 0.9 })), "one wallet buying it all is not the pattern");
  assert.ok(!matches(p, blank({ snipers: 1, topBuyShare: 0.05 })));
});
