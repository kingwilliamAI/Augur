import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "augur-fees-"));
process.env.DB_PATH = join(dir, "test.db");
process.env.COIN_TOKEN = "0xc0ffee";

const { openDb } = await import("./db.ts");
const { currentFeeRecipient, feeLedger, feeRecipients } = await import("./fees.ts");

/**
 * Who the fee goes to, as the ledger and the payout must see it.
 *
 * The launch row only ever knows the recipient the creator declared at launch, and the creator can
 * move the fee afterwards. A ledger that kept reading the first address would report a wallet that
 * no longer earns anything and miss the one that does, and a payout with no key would print a plan
 * for the wrong wallet. These pin the order and the takeover blocks.
 */

const db = openDb();
const ETH = "0x0000000000000000000000000000000000000000";
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xcccccccccccccccccccccccccccccccccccccccc";

let seq = 0;
function launch(recipient: string | null, block = 100, token = "0xtok" + (seq++)): string {
  db.prepare(`INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
    graduation_threshold_wei, graduation_threshold_eth, block, tx, log_index, ts, first_seen_at,
    creator_fee_recipient)
    VALUES (?,?,?,?,1,'1',1,?,?,0,?,?,?)`)
    .run(token, "0xcurve", A, ETH, block, "0xtx" + seq, 1_800_000_000, 1_800_000_000, recipient);
  return token;
}
function move(token: string, prev: string, next: string, block: number): void {
  db.prepare(`INSERT INTO fee_recipient_changes (token, tx, log_index, prev, next, block, ts)
    VALUES (?,?,?,?,?,?,?)`).run(token, `0xchg${token}-${block}`, 0, prev, next, block, 1_800_000_000 + block);
}

test("with no changes the launch's own recipient is the only one", () => {
  const t = launch(A);
  assert.deepEqual(feeRecipients(db, t), [{ address: A, fromBlock: 100 }]);
  assert.equal(currentFeeRecipient(db, t), A);
});

test("a move appends the new wallet from the block it took over", () => {
  const t = launch(A);
  move(t, A, B, 250);
  assert.deepEqual(feeRecipients(db, t), [
    { address: A, fromBlock: 100 },
    { address: B, fromBlock: 250 },
  ]);
  assert.equal(currentFeeRecipient(db, t), B);
});

test("moves are ordered by block, not by insertion", () => {
  const t = launch(A);
  move(t, B, C, 400);
  move(t, A, B, 300);
  assert.deepEqual(feeRecipients(db, t).map((r) => r.address), [A, B, C]);
  assert.equal(currentFeeRecipient(db, t), C);
});

test("a launch not yet enriched still knows its first recipient from the move", () => {
  const t = launch(null);
  move(t, A, B, 250);
  assert.deepEqual(feeRecipients(db, t).map((r) => r.address), [A, B]);
});

test("moving back to an earlier wallet does not list it twice", () => {
  const t = launch(A);
  move(t, A, B, 250);
  move(t, B, A, 300);
  assert.deepEqual(feeRecipients(db, t).map((r) => r.address), [A, B]);
  assert.equal(currentFeeRecipient(db, t), A);
});

test("an unknown token has nobody on record", () => {
  assert.deepEqual(feeRecipients(db, "0xnope"), []);
  assert.equal(currentFeeRecipient(db, "0xnope"), null);
});

test("the ledger owes each wallet separately, so an over-claimed old wallet hides nothing", () => {
  const coin = launch(A, 100, "0xc0ffee");
  move(coin, A, B, 250);
  const credit = db.prepare(`INSERT INTO fee_events (tx, log_index, kind, recipient, depositor, amount_wei, amount_eth, block, ts)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  credit.run("0xe1", 0, "credited", A, "0xd", "1000", 0, 110, 1);
  credit.run("0xe2", 0, "claimed", A, null, "1500", 0, 120, 2);
  credit.run("0xe3", 0, "credited", B, "0xd", "700", 0, 260, 3);
  const led = feeLedger(db);
  assert.equal(led.recipient, B);
  assert.equal(led.credited.wei, "1700");
  assert.equal(led.claimed.wei, "1500");
  assert.equal(led.unclaimed.wei, "700");
});
