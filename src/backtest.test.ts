import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bootstrapMean, checkPoolJoin, MIN_PEERS, replayRanks, simulateOne, summarise, withoutBest,
  type Costs, type EntryRule, type ExitRule, type PathPoint, type PoolLeg,
} from "./backtest.ts";
import type { Row } from "./features.ts";

/**
 * A backtest that is wrong does not crash. It prints a plausible number, and the more flattering the
 * bug the more likely it is to be believed and shipped. These cover the four places where that
 * happens here — every one of them found by a bug that was actually in this file.
 */

const ENTRY: EntryRule = { delayBlocks: 35, impact: 0 };
const FREE: Costs = { buy: 0, sell: 0 };
const HOLD: ExitRule = { takeProfit: null, stopLoss: null, holdBlocks: 10_000, followIntoPool: false };
const p = (block: number, price: number): PathPoint => ({ block, price, side: "buy" });

test("buys at the last price before the entry block, not the one printed in it", () => {
  // A fill in the same block as an existing trade assumes we won the ordering inside that block. A
  // backtest that quietly wins every race reports a number nobody can reproduce.
  const path = [p(0, 1), p(34, 2), p(35, 10), p(100, 20)];
  const a = simulateOne("t", path, 0, ENTRY, HOLD, FREE, null, null);
  assert.equal(a.trade?.entryPrice, 2, "the 10 printed at the entry block is not ours to take");
  assert.equal(a.trade?.gross, 10, "20 out of 2 in");
});

test("a target the price hit before we were in does not fill", () => {
  // The whole point of a limit order is that it fills forward. Scanning the entire path for a level
  // rather than the part after entry is the single easiest way to invent an edge here.
  const path = [p(0, 1), p(10, 100), p(34, 1), p(50, 1.1)];
  const exit: ExitRule = { takeProfit: 5, stopLoss: null, holdBlocks: 10_000, followIntoPool: false };
  const a = simulateOne("t", path, 0, ENTRY, exit, FREE, null, null);
  assert.equal(a.trade?.exitReason, "timeout", "the 100x happened at block 10 and we bought at 35");
  assert.ok((a.trade?.gross ?? 0) < 1.2);
});

test("stops and targets fire in the order the path reached them", () => {
  const path = [p(0, 1), p(40, 0.4), p(60, 5)];
  const exit: ExitRule = { takeProfit: 2, stopLoss: 0.5, holdBlocks: 10_000, followIntoPool: false };
  const a = simulateOne("t", path, 0, ENTRY, exit, FREE, null, null);
  assert.equal(a.trade?.exitReason, "stop-loss", "the stop came first in time, so it is what happened");
  assert.equal(a.trade?.gross, 0.5);
});

test("the pool leg is priced in the curve's units", () => {
  // The bug this exists for: curve prices are quote_wei per token_amt — raw both sides — while
  // `quotePerToken` returns whole quote per whole token. Against the 6-decimal quote asset the two
  // differ by 10^12, and one position returned 4,051,207,400x before this was caught. On an
  // 18-decimal quote asset the same mistake is exactly 1.0 and leaves no trace at all.
  const path = [p(0, 1), p(40, 1.5)];
  const pool: PoolLeg = { openPrice: 1.6, peakPrice: 3.4, peakBlock: 500 };
  const exit: ExitRule = { takeProfit: 3, stopLoss: null, holdBlocks: 100, followIntoPool: true };
  const a = simulateOne("t", path, 0, ENTRY, exit, FREE, pool, 50);
  assert.equal(a.trade?.exitReason, "pool-take-profit");
  assert.equal(a.trade?.gross, 3, "a 3x target fills at 3x, not at whatever the pool's scale is");
});

test("the handover check catches two legs on different scales", () => {
  const paths = new Map([["a", [p(0, 1), p(9, 2)]], ["b", [p(0, 1), p(9, 4)]]]);
  const same = new Map([["a", { openPrice: 2, peakPrice: 9, peakBlock: 1 }], ["b", { openPrice: 4, peakPrice: 9, peakBlock: 1 }]]);
  assert.equal(checkPoolJoin(paths, same).median, 1, "a token hands over at one price, seen twice");

  const scaled = new Map([["a", { openPrice: 2e12, peakPrice: 9e12, peakBlock: 1 }], ["b", { openPrice: 4e12, peakPrice: 9e12, peakBlock: 1 }]]);
  assert.equal(checkPoolJoin(paths, scaled).within2x, 0, "a decimal gap shows up here or nowhere");
});

test("a rank is a place among the launches that existed alongside it", () => {
  // Ranking against the whole database instead of the trailing window hands out top percentiles a
  // reader never saw, and does it silently: the numbers stay in range and only the meaning changes.
  const row = (ts: number): Row => ({ token: "t" + ts, ts, block: ts, label: 0, x: new Float64Array(0) });
  const win = 1000;
  // A full window of peers first, close enough in time to still be inside it, so the launches under
  // test are ranked against a real board rather than dropped for lack of one.
  const filler = Array.from({ length: MIN_PEERS + 10 }, (_, i) => row(i));
  const rows = [...filler, row(win), row(win + 1), row(win + 2)];
  const scores = Float64Array.from([...filler.map(() => 0.5), 0.99, 0.01, 0.5]);
  const pct = replayRanks(rows, scores, win);

  const first = filler.length;
  assert.equal(pct[first], 100, "the best score in its window tops it");
  assert.equal(pct[first + 1], 0, "the worst score in its window is the bottom of it");
  assert.ok(pct[first + 2] > 0 && pct[first + 2] < 100, "a middling score lands in between");
});

test("a launch with no window behind it is not ranked at all", () => {
  // Being first is not the same as being best, and a backtest that cannot tell them apart builds
  // its shortlist out of whichever launches the database happens to start with. This was the
  // failure: three launches in, the earliest of them was already "top 1%".
  const row = (ts: number): Row => ({ token: "t" + ts, ts, block: ts, label: 0, x: new Float64Array(0) });
  const pct = replayRanks([row(0), row(100), row(200)], Float64Array.from([0.1, 0.9, 0.5]), 1000);
  assert.ok([...pct].every((v) => Number.isNaN(v)), "three launches are not a six-hour board");
});

test("bootstrap brackets the mean and repeats itself", () => {
  const nets = Array.from({ length: 400 }, (_, i) => (i % 20 === 0 ? 6 : 0.7));
  const mean = nets.reduce((a, b) => a + b, 0) / nets.length;
  const ci = bootstrapMean(nets);
  assert.ok(ci.lo < mean && mean < ci.hi, "the interval contains the number it is about");
  assert.deepEqual(ci, bootstrapMean(nets), "seeded, so a reader can check the figure");
});

test("dropping the best positions exposes a result that is one lucky token", () => {
  const luck = [...Array.from({ length: 99 }, () => 0.5), 60];
  assert.ok(luck.reduce((a, b) => a + b, 0) / luck.length > 1, "profitable on the mean");
  assert.ok(withoutBest(luck, 1) < 1, "and not profitable without its single best trade");
});

test("launches that never filled return their stake rather than nothing", () => {
  // Counting an unfillable launch as a total loss understates the strategy; counting it as a win
  // overstates it. It is capital that was never deployed, and `staked` is the only column that
  // says so.
  const filled = simulateOne("t", [p(0, 1), p(40, 2)], 0, ENTRY, HOLD, FREE, null, null);
  const empty = simulateOne("u", [], 0, ENTRY, HOLD, FREE, null, null);
  const s = summarise("mixed", [filled, empty]);
  assert.equal(s.trades, 1);
  assert.equal(s.drops["no-path"], 1);
  assert.equal(s.meanNet, 2, "per position actually filled");
  assert.equal(s.totalReturn, 1.5, "the undeployed half came back whole");
});
