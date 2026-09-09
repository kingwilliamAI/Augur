import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Who counts as a trader worth following.
 *
 * This is the part of the feature that is a decision rather than an implementation, and the tests
 * are the decision written down. Wash trading is not the threat — a curve has no counterparty to
 * collude with, and round-tripping one costs fees both ways. Access is: creating the token, or being
 * on the creator's exemption list, hands a wallet a price rather than letting it find one. Both are
 * on chain, both are excluded, and the tests below are what stops that exclusion from being quietly
 * dropped later.
 */
const dir = mkdtempSync(join(tmpdir(), "augur-traders-"));
process.env.DB_PATH = join(dir, "test.db");
process.env.TRADER_MIN_CLOSED = "3";

const { openDb } = await import("./db.ts");
const T = await import("./traders.ts");

const db = openDb();
const T0 = 1_800_000_000;
const ETH = "0x0000000000000000000000000000000000000000";
const addr = (n: number): string => "0x" + String(n).padStart(40, "0");
const tok = (n: number): string => "0xdd" + String(n).padStart(38, "0");

let seq = 0;
function makeToken(token: string, creator = addr(1)): void {
  db.prepare(`INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
    graduation_threshold_wei, graduation_threshold_eth, block, tx, log_index, ts, first_seen_at, symbol, launch_sender)
    VALUES (?,?,?,?,1,'1',1,?,?,0,?,?,'T',?)`)
    .run(token, "0xc" + (seq++), creator, ETH, seq, "0xtx" + seq, T0, T0, creator);
}

/** A wallet that bought for `inQ` and sold everything for `outQ`. */
function roundTrip(wallet: string, token: string, inQ: number, outQ: number, ts = T0): void {
  T.applyTrade(db, { wallet, token, side: "buy", quote: inQ, tokens: 1000, ts });
  T.applyTrade(db, { wallet, token, side: "sell", quote: outQ, tokens: 1000, ts: ts + 60 });
}

test("trades fold into a position rather than being stored", () => {
  makeToken(tok(1));
  T.applyTrade(db, { wallet: addr(10), token: tok(1), side: "buy", quote: 1, tokens: 500, ts: T0 });
  T.applyTrade(db, { wallet: addr(10), token: tok(1), side: "buy", quote: 2, tokens: 500, ts: T0 + 10 });
  const p = db.prepare("SELECT * FROM trader_positions WHERE wallet = ? AND token = ?")
    .get(addr(10), tok(1)) as { quote_in: number; tokens_in: number; buys: number; last_ts: number };
  assert.equal(p.quote_in, 3);
  assert.equal(p.tokens_in, 1000);
  assert.equal(p.buys, 2);
  assert.equal(p.last_ts, T0 + 10);
});

test("a creator trading their own token is not building a record", () => {
  const creator = addr(20);
  makeToken(tok(2), creator);
  roundTrip(creator, tok(2), 1, 50);
  const p = db.prepare("SELECT insider FROM trader_positions WHERE wallet = ? AND token = ?")
    .get(creator, tok(2)) as { insider: number };
  assert.equal(p.insider, 1, "buying a token you launched is access, not judgement");
  assert.equal(T.recordOf(db, creator), null);
});

test("a wallet waived the opening tax is not building a record either", () => {
  const insider = addr(21);
  makeToken(tok(3));
  db.prepare("INSERT INTO exemptions (token, address) VALUES (?,?)").run(tok(3), insider);
  roundTrip(insider, tok(3), 1, 90);
  const p = db.prepare("SELECT insider FROM trader_positions WHERE wallet = ? AND token = ?")
    .get(insider, tok(3)) as { insider: number };
  assert.equal(p.insider, 1,
    "the exemption waives the 99% opening tax, which is the only thing stopping everyone else buying first");
});

test("the same wallet still counts in somebody else's token", () => {
  const creator = addr(20);
  for (const n of [30, 31, 32]) {
    makeToken(tok(n));
    roundTrip(creator, tok(n), 1, 3, T0 + n);
  }
  const rec = T.recordOf(db, creator)!;
  assert.equal(rec.closed, 3, "excluding a creator's own launches is per token, not per wallet");
  assert.ok(rec.realisedUsd > 0);
});

test("a position is closed when nearly all of it is sold, not exactly all", () => {
  const w = addr(40);
  makeToken(tok(40));
  T.applyTrade(db, { wallet: w, token: tok(40), side: "buy", quote: 1, tokens: 1000, ts: T0 });
  T.applyTrade(db, { wallet: w, token: tok(40), side: "sell", quote: 4, tokens: 900, ts: T0 + 10 });
  assert.equal(T.recordOf(db, w), null, "ninety per cent out is still holding");

  T.applyTrade(db, { wallet: w, token: tok(40), side: "sell", quote: 1, tokens: 60, ts: T0 + 20 });
  assert.equal(T.recordOf(db, w)?.closed, 1, "and a curve leaves dust, so the last few per cent cannot be required");
});

test("an open position is not counted as a loss", () => {
  const w = addr(41);
  makeToken(tok(41));
  T.applyTrade(db, { wallet: w, token: tok(41), side: "buy", quote: 5, tokens: 1000, ts: T0 });
  assert.equal(T.recordOf(db, w), null, "somebody still holding has not lost anything yet");
});

test("the record carries what it is made of, so a reader can discount it", () => {
  const w = addr(50);
  for (const n of [50, 51, 52, 53]) {
    makeToken(tok(n));
    roundTrip(w, tok(n), 1, n === 53 ? 0.2 : 5, T0 + n);
  }
  const rec = T.recordOf(db, w)!;
  assert.equal(rec.closed, 4);
  assert.equal(rec.wins, 3);
  assert.equal(Math.round(rec.winRate * 100), 75);
  assert.ok(rec.bestMultiple >= 5, "the best single position is printed, not just the sum");
});

test("a wallet with too few closed positions does not rank", () => {
  const w = addr(60);
  makeToken(tok(60));
  roundTrip(w, tok(60), 1, 100, T0);
  assert.equal(T.isRanked(db, w), null, "one enormous win is luck until it is repeated");

  assert.equal(T.leaderboard(db).some((r) => r.wallet === w), false);
});

test("the leaderboard ranks by realised dollars and reports the win rate beside it", () => {
  const big = addr(70);
  const steady = addr(71);
  for (const n of [70, 71, 72, 73]) {
    makeToken(tok(n));
    roundTrip(big, tok(n), 10, 40, T0 + n);
    roundTrip(steady, tok(n), 1, 1.5, T0 + n);
  }
  const board = T.leaderboard(db, { limit: 10 });
  const bigRow = board.findIndex((r) => r.wallet === big);
  const steadyRow = board.findIndex((r) => r.wallet === steady);
  assert.ok(bigRow >= 0 && steadyRow >= 0);
  assert.ok(bigRow < steadyRow, "dollars order the list");
  assert.equal(board[steadyRow].winRate, 1, "and the win rate is there to say what kind of record it is");
});

test("a position in an asset with no price is dropped rather than counted at nothing", () => {
  const w = addr(80);
  const oddQuote = addr(999);
  db.prepare("INSERT INTO quote_assets (address, symbol, decimals) VALUES (?,?,?)")
    .run(oddQuote, "NOPRICE", 18);
  db.prepare(`INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
    graduation_threshold_wei, graduation_threshold_eth, block, tx, log_index, ts, first_seen_at, symbol, launch_sender)
    VALUES (?,?,?,?,1,'1',1,9,'0xtxq',0,?,?,'Q',?)`)
    .run(tok(80), "0xcq", addr(2), oddQuote, T0, T0, addr(2));
  roundTrip(w, tok(80), 5, 50, T0);
  assert.equal(T.recordOf(db, w), null,
    "counting an unpriced quote asset at zero would read as a total loss and punish everyone who used it");
});

test("a chat can watch a token and stop watching it", () => {
  assert.equal(T.watchToken(db, 1, tok(1), T0), true);
  assert.equal(T.watchToken(db, 1, "not a token", T0), false);
  assert.deepEqual(T.watchedBy(db, 1), [tok(1)]);
  assert.deepEqual(T.watchersOfToken(db, tok(1)), [1]);
  T.unwatchToken(db, 1, tok(1));
  assert.deepEqual(T.watchedBy(db, 1), []);
});

test("a ranked wallet opening a position in a watched token is worth one message", () => {
  const trader = addr(70);            // already ranked by the leaderboard test
  const watched = tok(90);
  makeToken(watched);
  T.watchToken(db, 5, watched, T0);
  T.applyTrade(db, { wallet: trader, token: watched, side: "buy", quote: 3, tokens: 100, ts: T0 + 5000 });

  const hits = T.pendingTraderAlerts(db, T0);
  const mine = hits.filter((h) => h.chatId === 5 && h.token === watched);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].wallet, trader);
  assert.ok(mine[0].record.closed >= 3, "the message can say what the record is made of");

  T.markTraderSent(db, 5, watched, trader, T0);
  assert.equal(T.pendingTraderAlerts(db, T0).some((h) => h.chatId === 5 && h.token === watched), false,
    "adding to a position is not a second decision");
});

test("an unranked wallet buying a watched token says nothing", () => {
  const nobody = addr(95);
  const watched = tok(91);
  makeToken(watched);
  T.watchToken(db, 6, watched, T0);
  T.applyTrade(db, { wallet: nobody, token: watched, side: "buy", quote: 3, tokens: 100, ts: T0 + 5000 });
  assert.equal(T.pendingTraderAlerts(db, T0).some((h) => h.chatId === 6), false);
});

test("an insider buying a watched token is not a trader arriving", () => {
  const creator = addr(96);
  const watched = tok(92);
  makeToken(watched, creator);
  T.watchToken(db, 7, watched, T0);
  T.applyTrade(db, { wallet: creator, token: watched, side: "buy", quote: 3, tokens: 100, ts: T0 + 5000 });
  assert.equal(T.pendingTraderAlerts(db, T0).some((h) => h.chatId === 7), false);
});
