import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Following a wallet, driven without a bot token or a network.
 *
 * Two of these are the reason the feature is not three lines in the command loop. One is that a
 * wallet is two columns: the address a reader copies off a card is `launch_sender`, and the address
 * the factory event carries is `deployer`. They differ on about a sixth of launches, so a follow
 * that matched only one of them would look like it worked and then quietly never fire for exactly
 * the launches made through a contract.
 *
 * The other is the window. A launch is written the moment it is seen, and the sender column is
 * filled a few seconds later; a pass that read the row once, at arrival, would decide nobody follows
 * it before the answer existed.
 */

const dir = mkdtempSync(join(tmpdir(), "augur-follows-"));
process.env.DB_PATH = join(dir, "test.db");

const { openDb } = await import("./db.ts");
const F = await import("./follows.ts");

const db = openDb();
const T0 = 1_800_000_000;
const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const MULTICALL = "0xca11bde05977b3631167028862be2a173976ca11";

let nextBlock = 1000;

/** One launch, as ingest writes it: the deployer from the event, the sender from the transaction. */
function launch(token: string, opts: { deployer: string; sender?: string | null; ts?: number; symbol?: string }): void {
  const block = nextBlock++;
  db.prepare(`INSERT INTO launches
    (token, curve, deployer, pair_token, launch_config_id, graduation_threshold_wei,
     graduation_threshold_eth, block, tx, log_index, ts, launch_sender, symbol, first_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    token, `${token}c`, opts.deployer, "0x0000000000000000000000000000000000000000", 1,
    "1000", 1, block, `0x${block}`, 0, opts.ts ?? T0, opts.sender ?? null, opts.symbol ?? "TKN", opts.ts ?? T0);
}

const graduate = (token: string, ts = T0 + 60): void => {
  db.prepare(`INSERT INTO graduations (token, block, tx, ts, position_id, token_amount, pair_wei, pair_eth)
    VALUES (?,?,?,?,?,?,?,?)`).run(token, nextBlock++, `0xg${token}`, ts, "1", "1", "1", 1);
};

test("a wallet is followed once, and the list says so", () => {
  assert.deepEqual(F.follow(db, 1, ALICE, T0, 3), { ok: true, count: 1 });
  assert.deepEqual(F.follow(db, 1, ALICE, T0, 3), { ok: false, reason: "already", count: 1 },
    "asking twice is not an error, but it is not a second row either");
  assert.deepEqual(F.followsOf(db, 1).map((f) => f.address), [ALICE]);
});

test("the cap is a limit on the list, not on the alerts", () => {
  F.follow(db, 2, ALICE, T0, 2);
  F.follow(db, 2, BOB, T0, 2);
  const third = F.follow(db, 2, "0x3333333333333333333333333333333333333333", T0, 2);
  assert.deepEqual(third, { ok: false, reason: "full", count: 2 });
  assert.equal(F.followsOf(db, 2).length, 2);
});

test("an address is stored and matched in one case", () => {
  F.follow(db, 3, ALICE.toUpperCase(), T0, 3);
  assert.deepEqual(F.followsOf(db, 3).map((f) => f.address), [ALICE],
    "a reader copying an address off an explorer gets a checksummed one");
  assert.equal(F.unfollow(db, 3, ALICE.toUpperCase()), true);
  assert.equal(F.unfollow(db, 3, ALICE), false, "already gone");
});

test("a launch sent through a contract still belongs to the wallet that sent it", () => {
  launch("0xaaa1", { deployer: MULTICALL, sender: ALICE });
  const rows = F.recentLaunches(db, T0 - 600);
  const row = rows.find((r) => r.token === "0xaaa1");
  assert.ok(row);
  assert.equal(F.followedBy(row, new Set([ALICE])), ALICE,
    "the deployer here is Multicall3, which is nobody's creator");
  assert.equal(F.followedBy(row, new Set([MULTICALL])), MULTICALL,
    "following the contract itself still matches, because that is what was asked for");
  assert.equal(F.followedBy(row, new Set([BOB])), null);
});

test("a launch seen before its sender is read matches on the deployer", () => {
  launch("0xaaa2", { deployer: BOB, sender: null });
  const row = F.recentLaunches(db, T0 - 600).find((r) => r.token === "0xaaa2");
  assert.ok(row);
  assert.equal(F.followedBy(row, new Set([BOB])), BOB,
    "the sender column is filled seconds later; the alert cannot wait for it");
});

test("the window is what a late-filled sender needs, and it is wide", () => {
  launch("0xold", { deployer: BOB, sender: ALICE, ts: T0 - 3600 });
  const tokens = F.recentLaunches(db, T0 - 600).map((r) => r.token);
  assert.ok(!tokens.includes("0xold"), "an hour old is not what this alert is about");
});

test("a record counts both columns, and rates it against the base", () => {
  for (let i = 0; i < 3; i++) launch(`0xrec${i}`, { deployer: ALICE, sender: ALICE, ts: T0 + i });
  launch("0xrec3", { deployer: MULTICALL, sender: ALICE, ts: T0 + 3 });
  graduate("0xrec1");

  const rec = F.walletRecord(db, ALICE);
  assert.equal(rec.launches, 6, "four here, plus the two earlier tests sent through a contract");
  assert.equal(rec.graduations, 1);
  assert.ok(rec.gradRate !== null && Math.abs(rec.gradRate - 1 / 6) < 1e-9);
  assert.equal(rec.lastTs, T0 + 3);
});

test("a wallet nobody has seen launch anything reads as empty, not as a zero rate", () => {
  const rec = F.walletRecord(db, "0x9999999999999999999999999999999999999999");
  assert.equal(rec.launches, 0);
  assert.equal(rec.graduations, 0);
  assert.equal(rec.gradRate, null, "0 of 0 is not a 0% record, it is no record");
  assert.equal(rec.best, null);
});

test("the base rate ignores launches too young to have an answer", () => {
  assert.equal(F.baseGradRate(db, T0), null, "a handful of rows is not a base rate");
  for (let i = 0; i < 200; i++) launch(`0xbase${i}`, { deployer: BOB, sender: BOB, ts: T0 - 86400 });
  for (let i = 0; i < 4; i++) graduate(`0xbase${i}`, T0 - 86000);
  // Everything above is a day old, so it settles; the launches from the tests before this one are
  // stamped at T0 and must not count against the wallets that made them.
  const base = F.baseGradRate(db, T0 + 3600);
  assert.ok(base !== null);
  assert.ok(base > 0.015 && base < 0.03, `four in two hundred and change, got ${base}`);
  assert.equal(F.baseGradRate(db, T0 - 90000), null, "before any of it had settled there is nothing to report");
});

test("only chats that follow something are looked at", () => {
  const chats = F.followingChats(db);
  assert.ok(chats.includes(1) && chats.includes(2));
  assert.ok(!chats.includes(3), "unfollowed its only wallet");
});

test("teardown", () => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
