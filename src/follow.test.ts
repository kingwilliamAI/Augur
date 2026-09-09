import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Following a creator, without a bot or a network.
 *
 * The two things worth guarding here are both about who a follow is *for*. It has to match the
 * wallet that sent the launch rather than the deployer the event names, because Multicall3 sits in
 * that column for thousands of unrelated people and following it would mean following all of them.
 * And a creator's record has to be the best of the three places a peak can live, because leaving out
 * any one of them under-reports exactly the creators worth following.
 */
const dir = mkdtempSync(join(tmpdir(), "augur-follow-"));
process.env.DB_PATH = join(dir, "test.db");
process.env.TIER1_TOKENS = "1000";
process.env.TIER2_TOKENS = "10000";
process.env.FOLLOW_LIMIT_TIER1 = "5";

const { openDb } = await import("./db.ts");
const F = await import("./follow.ts");
const T = await import("./tiers.ts");

const db = openDb();
const T0 = 1_800_000_000;
const ETH = "0x0000000000000000000000000000000000000000";
const addr = (n: number): string => "0x" + String(n).padStart(40, "0");

/** A chat that has sent /start, which is the only way one enters tg_subs. */
function subscribed(chatId: number, at = T0 - 86_400): void {
  db.prepare(`INSERT INTO tg_subs (chat_id, min_score, created_at, last_at) VALUES (?,8,?,0)
    ON CONFLICT(chat_id) DO NOTHING`).run(chatId, at);
}

/** A chat holding enough to be the tier it asks for. Subscribed, because an unsubscribed chat hears nothing. */
function holder(chatId: number, tier: 1 | 2, linkedAt = T0 - 86_400): void {
  subscribed(chatId, linkedAt);
  db.prepare(`INSERT INTO wallet_links (chat_id, address, linked_at, balance, checked_at, tier, raw_tier, raw_since)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET tier = excluded.tier`)
    .run(chatId, addr(900 + chatId), linkedAt, "0", T0, tier, tier, T0);
}

let seq = 0;
function launch(opts: { sender?: string | null; deployer?: string; symbol?: string; ts?: number; graduated?: boolean }): string {
  const token = "0xtok" + (seq++);
  db.prepare(`INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
    graduation_threshold_wei, graduation_threshold_eth, block, tx, log_index, ts, first_seen_at,
    symbol, launch_sender)
    VALUES (?,?,?,?,1,'1',1,?, ?,0,?,?,?,?)`)
    .run(token, "0xcurve", opts.deployer ?? addr(1), ETH, seq, "0xtx" + seq,
      opts.ts ?? T0, opts.ts ?? T0, opts.symbol ?? "TEST", opts.sender ?? null);
  if (opts.graduated) {
    db.prepare(`INSERT INTO graduations (token, block, tx, ts, position_id, token_amount, pair_wei, pair_eth)
      VALUES (?,?,?,?,'1','1','1',1)`).run(token, seq, "0xg" + seq, (opts.ts ?? T0) + 60);
  }
  return token;
}

test("a follow needs an address that could be a wallet", () => {
  holder(1, 2);
  for (const junk of ["", "0x", "not an address", "0x1234"]) {
    assert.equal(F.follow(db, 1, junk, T0).ok, false, `${junk} must not be followable`);
  }
  assert.equal(F.follow(db, 1, addr(1), T0).ok, true);
});

test("following is part of the paid half", () => {
  const res = F.follow(db, 404, addr(2), T0);
  assert.equal(res.ok === false && res.reason, "not-a-holder", "a chat with no link gets nothing");
  assert.deepEqual(F.following(db, 404), []);
});

test("tier 1 is capped and tier 2 is not", () => {
  holder(2, 1);
  for (let i = 0; i < 5; i++) assert.equal(F.follow(db, 2, addr(100 + i), T0).ok, true);
  const over = F.follow(db, 2, addr(200), T0);
  assert.equal(over.ok === false && over.reason, "limit");
  assert.equal(over.ok === false && over.limit, 5, "the message has to say what the limit is");

  holder(3, 2);
  for (let i = 0; i < 12; i++) assert.equal(F.follow(db, 3, addr(300 + i), T0).ok, true);
  assert.equal(F.following(db, 3).length, 12);
});

test("the same creator twice is a no-op, not a second slot", () => {
  holder(4, 1);
  assert.equal(F.follow(db, 4, addr(500), T0).ok, true);
  const again = F.follow(db, 4, addr(500), T0);
  assert.equal(again.ok === false && again.reason, "already");
  assert.equal(F.following(db, 4).length, 1);
});

test("unfollow removes one and says whether it did", () => {
  holder(5, 1);
  F.follow(db, 5, addr(600), T0);
  assert.equal(F.unfollow(db, 5, addr(600)), true);
  assert.equal(F.unfollow(db, 5, addr(600)), false, "removing what is not there is not an error, but it is not a removal");
  assert.deepEqual(F.following(db, 5), []);
});

test("selling stops the alerts without erasing the list", () => {
  holder(6, 1);
  F.follow(db, 6, addr(700), T0);
  assert.deepEqual(F.watchersOf(db, addr(700)), [6]);

  db.prepare("UPDATE wallet_links SET tier = 0 WHERE chat_id = 6").run();
  assert.deepEqual(F.watchersOf(db, addr(700)), [], "a lapsed tier stops delivery");
  assert.equal(F.following(db, 6).length, 1, "and keeps the list, because it may come back");
});

test("a follow matches the wallet that sent the launch, not the deployer the event names", () => {
  const MULTICALL = "0xca11bde05977b3631167028862be2a173976ca11";
  const creator = addr(42);
  const token = launch({ deployer: MULTICALL, sender: creator, ts: T0 + 10 });

  holder(7, 2);
  F.follow(db, 7, creator, T0);
  const hits = F.pendingFollowAlerts(db, T0);
  assert.ok(hits.some((h) => h.token === token && h.chatId === 7),
    "the creator is the sender; the deployer here is a contract thousands of people share");

  holder(8, 2);
  F.follow(db, 8, MULTICALL, T0);
  assert.equal(F.pendingFollowAlerts(db, T0).some((h) => h.chatId === 8), false,
    "following Multicall3 must not mean following everybody who ever used it");
});

test("a deployer many people launch through cannot be followed", () => {
  const ROUTER = addr(888);
  // Three unrelated wallets launching through the same contract. Following it would subscribe you
  // to all of them and to everyone who uses it tomorrow.
  for (let i = 0; i < 3; i++) launch({ deployer: ROUTER, sender: addr(870 + i), ts: T0 - 1000 });

  holder(11, 2);
  const res = F.follow(db, 11, ROUTER, T0);
  assert.equal(res.ok === false && res.reason, "shared");
  assert.equal(res.ok === false && res.senders, 3, "the message says how many, so the refusal is checkable");
  assert.equal(F.sharedDeployer(db, addr(870)), 0, "a wallet that launches for itself is not shared");
});

test("a launch is attributed to its sender, and to its deployer only while the sender is unknown", () => {
  const ROUTER = addr(889);
  const realCreator = addr(890);
  holder(12, 2);
  F.follow(db, 12, realCreator, T0);

  // The watcher enriches in batches, so for the first seconds launch_sender is null.
  const unenriched = launch({ deployer: ROUTER, sender: null, ts: T0 + 50 });
  assert.equal(F.pendingFollowAlerts(db, T0).some((h) => h.chatId === 12), false,
    "an unenriched router launch is not evidence that this creator sent it");

  db.prepare("UPDATE launches SET launch_sender = ? WHERE token = ?").run(realCreator, unenriched);
  assert.ok(F.pendingFollowAlerts(db, T0).some((h) => h.chatId === 12 && h.token === unenriched),
    "and once the sender is known, it is theirs");
});

test("an alert is offered once and then never again", () => {
  const creator = addr(43);
  const token = launch({ sender: creator, ts: T0 + 20 });
  holder(9, 2);
  F.follow(db, 9, creator, T0);

  assert.equal(F.pendingFollowAlerts(db, T0).filter((h) => h.chatId === 9).length, 1);
  F.markFollowSent(db, 9, token, T0);
  assert.equal(F.pendingFollowAlerts(db, T0).filter((h) => h.chatId === 9).length, 0);
});

test("a launch older than the watermark is not resurrected", () => {
  const creator = addr(44);
  launch({ sender: creator, ts: T0 - 86_400 });
  holder(10, 2);
  F.follow(db, 10, creator, T0);
  assert.equal(F.pendingFollowAlerts(db, T0 - 600).some((h) => h.chatId === 10), false,
    "subscribing must not empty a day of history into the chat");
});

test("a creator hears about their own launch without following anyone", () => {
  const mine = addr(45);
  subscribed(20);
  db.prepare(`INSERT INTO wallet_links (chat_id, address, linked_at, balance, checked_at, tier, raw_tier, raw_since)
    VALUES (?,?,?,?,?,?,?,?)`).run(20, mine, T0 - 86_400, "0", T0, 0, 0, T0);
  const token = launch({ sender: mine, ts: T0 + 30 });

  const hits = F.pendingFollowAlerts(db, T0).filter((h) => h.chatId === 20);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].own, true, "a fact about your own launch is not a thing being sold to you");
  assert.equal(hits[0].token, token);
  assert.equal(F.followLimit(0), 0, "and the same chat still cannot follow anybody else");
});

test("following your own wallet gets you one message, not two", () => {
  const mine = addr(46);
  subscribed(21);
  db.prepare(`INSERT INTO wallet_links (chat_id, address, linked_at, balance, checked_at, tier, raw_tier, raw_since)
    VALUES (?,?,?,?,?,?,?,?)`).run(21, mine, T0 - 86_400, "0", T0, 2, 2, T0);
  F.follow(db, 21, mine, T0);
  launch({ sender: mine, ts: T0 + 40 });

  const hits = F.pendingFollowAlerts(db, T0).filter((h) => h.chatId === 21);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].own, true, "and it is the one that knows the launch is theirs");
});

test("a chat that sent /stop hears nothing, including about its own launches", () => {
  const mine = addr(47);
  const followed = addr(48);
  holder(30, 2);
  db.prepare("UPDATE wallet_links SET address = ? WHERE chat_id = 30").run(mine);
  F.follow(db, 30, followed, T0 - 100);
  launch({ sender: mine, ts: T0 + 300 });
  launch({ sender: followed, ts: T0 + 301 });
  assert.equal(F.pendingFollowAlerts(db, T0).filter((h) => h.chatId === 30).length, 2, "both paths reach a live chat");

  // /stop deletes the subscription. The wallet link and the follows stay — /unlink is what forgets
  // a wallet — but nothing may be sent to a chat that asked to be left alone.
  db.prepare("DELETE FROM tg_subs WHERE chat_id = 30").run();
  assert.equal(F.pendingFollowAlerts(db, T0).some((h) => h.chatId === 30), false,
    "the own-launch path escaped /stop once, because it reads wallet_links rather than the subscription");
});

test("following starts the clock rather than emptying the last ten minutes into the chat", () => {
  const creator = addr(49);
  holder(31, 2);
  const before = launch({ sender: creator, ts: T0 + 400 });
  F.follow(db, 31, creator, T0 + 500);
  const after = launch({ sender: creator, ts: T0 + 600 });

  const hits = F.pendingFollowAlerts(db, T0).filter((h) => h.chatId === 31);
  assert.equal(hits.some((h) => h.token === before), false, "a launch from before the follow is not news");
  assert.ok(hits.some((h) => h.token === after));
});

test("a record does not count the launch it is describing", () => {
  const creator = addr(55);
  const older = launch({ sender: creator, ts: T0 + 700, graduated: true });
  const newest = launch({ sender: creator, ts: T0 + 800 });

  const all = F.creatorRecord(db, creator);
  assert.equal(all.launches, 2);

  const excluding = F.creatorRecord(db, creator, newest);
  assert.equal(excluding.launches, 1, "the alert says what they did BEFORE this one");
  assert.equal(excluding.graduations, 1);
  assert.ok(older);
});

test("the record counts launches and graduations by the same wallet rule", () => {
  const creator = addr(50);
  launch({ sender: creator, ts: T0 + 100 });
  launch({ sender: creator, ts: T0 + 200, graduated: true });
  launch({ sender: null, deployer: creator, ts: T0 + 300 });

  const rec = F.creatorRecord(db, creator);
  assert.equal(rec.launches, 3, "a launch with no sender falls back to the deployer, as the card does");
  assert.equal(rec.graduations, 1);
  assert.equal(rec.firstSeen, T0 + 100);
});

test("the best peak is the best of the curve, the summary and the pool", () => {
  const creator = addr(51);
  const a = launch({ sender: creator, symbol: "SMALL", ts: T0 + 400 });
  const b = launch({ sender: creator, symbol: "BIG", ts: T0 + 500 });

  // A folded summary for one, raw trades for the other. Reading only one source would report the
  // wrong token as this creator's best.
  db.prepare(`INSERT INTO curve_summary (token, first_price, peak_price, last_price, trades, buys, sells, stats_json, compacted_at)
    VALUES (?, 1e-9, 2e-9, 1e-9, 10, 6, 4, '{}', ?)`).run(a, T0);
  db.prepare(`INSERT INTO curve_trades (token, tx, log_index, side, actor, recipient, quote_wei,
    quote_eth, token_amt, fee_wei, tax_wei, tax_eth, block, ts)
    VALUES (?, '0xt', 0, 'buy', '0x1', '0x1', '9000000000', 9, '1000000000', '0', '0', 0, 1, ?)`)
    .run(b, T0);

  const rec = F.creatorRecord(db, creator);
  assert.equal(rec.bestSymbol, "BIG", "9e-9 from the trades beats 2e-9 from the summary");
  assert.ok(rec.bestUsd !== null && rec.bestUsd > 0);
});

test("a creator nobody has heard of has a record, and it is empty rather than missing", () => {
  const rec = F.creatorRecord(db, addr(999));
  assert.equal(rec.launches, 0);
  assert.equal(rec.graduations, 0);
  assert.equal(rec.bestUsd, null);
  assert.equal(rec.firstSeen, null);
});

test("the board can report on how much following is going on", () => {
  const c = F.followCounts(db);
  assert.ok(c.chats > 0 && c.addresses > 0);
});

test("the limit follows the tier, and tier 2 is uncapped", () => {
  assert.equal(F.followLimit(0), 0);
  assert.equal(F.followLimit(1), 5);
  assert.equal(F.followLimit(2), Infinity);
  assert.equal(T.tierOf(db, 3), 2, "the fixture holder really is tier 2");
});
