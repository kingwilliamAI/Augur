import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Block } from "./blocktail.ts";

/**
 * The block tail, driven without a chain.
 *
 * The reader exists because two facts are invisible in logs, and it is the only thing in this
 * project that cannot shrug off a reorg: every log indexer upserts by primary key, so a replayed
 * block overwrites, while a native transfer read twice on two sides of a reorg would be two rows
 * about one event. So the chain check is the thing under test here, along with the pacing that keeps
 * this reader from racing the watcher for the endpoint they share.
 */
const dir = mkdtempSync(join(tmpdir(), "augur-tail-"));
process.env.DB_PATH = join(dir, "test.db");
process.env.TAIL_IDLE_MS = "1";
process.env.TAIL_BACKOFF_MS = "1";
process.env.FRESH_WINDOW_BLOCKS = "5000";

const { openDb } = await import("./db.ts");
const { chainBreak, runTail } = await import("./blocktail.ts");
const FU = await import("./fundings.ts");

const db = openDb();
const addr = (n: number): string => "0x" + String(n).padStart(40, "0");
const hex = (n: number): string => "0x" + n.toString(16);

/** A chain of blocks whose hashes actually link, so a break has to be introduced on purpose. */
function chain(from: number, count: number, txs: (n: number) => Block["transactions"] = () => []): Block[] {
  return Array.from({ length: count }, (_, i) => ({
    number: from + i,
    hash: "0xh" + (from + i),
    parentHash: "0xh" + (from + i - 1),
    timestamp: 1_800_000_000 + (from + i),
    transactions: txs(from + i),
  }));
}

const transfer = (from: string, to: string | null, wei: bigint, input = "0x"): Block["transactions"][number] => ({
  hash: "0xtx" + from.slice(-4) + (to ?? "none").slice(-4) + wei.toString(),
  from, to, value: hex(Number(wei)), input,
});

test("a run of linked blocks is a chain", () => {
  assert.equal(chainBreak(chain(100, 5)), null);
  assert.equal(chainBreak(chain(100, 5), "0xh99"), null, "and the first one is checked against what came before");
});

test("a gap, a wrong parent, or a fork is a break", () => {
  const gap = [...chain(100, 2), ...chain(103, 2)];
  assert.equal(chainBreak(gap), 103, "a missing block is not a chain");

  const forked = chain(100, 3);
  forked[2].parentHash = "0xsomethingelse";
  assert.equal(chainBreak(forked), 102);

  assert.equal(chainBreak(chain(100, 3), "0xnotthat"), 100,
    "a first block that does not follow what was already read is the reorg case that matters");
});

test("the tail reads forward, in order, and checkpoints as it goes", async () => {
  const seen: number[] = [];
  const progress: number[] = [];
  await runTail({
    head: async () => 130,
    read: async (from, count) => chain(from, count),
    onBlock: (b) => { seen.push(b.number); },
    onProgress: (s) => { progress.push(s.cursor); },
    onStatus: () => {},
    lag: 0,
    stop: () => seen.length >= 25,
  }, { cursor: 100 });

  assert.ok(seen.length >= 25);
  assert.deepEqual(seen.slice(0, 5), [100, 101, 102, 103, 104], "in order, with no holes");
  assert.ok(progress.length >= 2, "checkpointed per batch, not once at the end");
  assert.ok(progress[0] > 100);
});

test("it stays behind the head by the lag it was given", async () => {
  const seen: number[] = [];
  let calls = 0;
  await runTail({
    head: async () => { calls++; return 110; },
    read: async (from, count) => chain(from, count),
    onBlock: (b) => { seen.push(b.number); },
    onStatus: () => {},
    lag: 6,
    stop: () => calls > 4,
  }, { cursor: 100 });
  assert.equal(Math.max(...seen), 104, "head 110 with a lag of 6 stops at 104, not at 110");
});

test("a reorg rewinds rather than carrying on", async () => {
  const reorgs: number[] = [];
  const seen: number[] = [];
  let served = 0;
  await runTail({
    head: async () => 200,
    read: async (from, count) => {
      served++;
      // The second batch comes back on a different fork; after the rewind the chain is consistent.
      if (served === 2) {
        const bad = chain(from, count);
        bad[0].parentHash = "0xdifferentfork";
        return bad;
      }
      return chain(from, count);
    },
    onBlock: (b) => { seen.push(b.number); },
    onReorg: (at) => { reorgs.push(at); },
    onStatus: () => {},
    lag: 0,
    stop: () => seen.length >= 30,
  }, { cursor: 100 });

  assert.equal(reorgs.length >= 1, true, "the break was noticed rather than written");
  assert.ok(reorgs[0] >= 110, "and it was noticed at the block that broke");
});

test("an empty or refused batch waits instead of spinning", async () => {
  let reads = 0;
  const seen: number[] = [];
  await runTail({
    head: async () => 200,
    read: async (from, count) => {
      reads++;
      if (reads <= 3) return [];          // the node has nothing for a range it should have
      if (reads === 4) throw new Error("HTTP 429");
      return chain(from, count);
    },
    onBlock: (b) => { seen.push(b.number); },
    onStatus: () => {},
    lag: 0,
    stop: () => seen.length >= 10,
  }, { cursor: 100 });
  assert.ok(seen.length >= 10, "a refusal is survivable, not fatal");
  assert.equal(seen[0], 100, "and nothing was skipped over while waiting");
});

test("a native transfer is value with no calldata, and nothing else", () => {
  assert.equal(FU.isNativeTransfer(transfer(addr(1), addr(2), 5n)), true);
  assert.equal(FU.isNativeTransfer(transfer(addr(1), addr(2), 0n)), false, "no value is not funding");
  assert.equal(FU.isNativeTransfer(transfer(addr(1), addr(2), 5n, "0xa9059cbb")), false,
    "value with calldata is a contract call: counting those is twelve times the rows and none of the meaning");
  assert.equal(FU.isNativeTransfer(transfer(addr(1), null, 5n)), false, "a contract creation funds nobody");
});

test("only transfers into wallets that matter are kept", () => {
  const launcher = addr(10);
  const stranger = addr(11);
  db.prepare(`INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
    graduation_threshold_wei, graduation_threshold_eth, block, tx, log_index, ts, first_seen_at, launch_sender)
    VALUES ('0xtl','0xc',?,'0x0000000000000000000000000000000000000000',1,'1',1,1,'0xtx',0,1,1,?)`)
    .run(launcher, launcher);

  assert.equal(FU.walletMatters(db, launcher), true);
  assert.equal(FU.walletMatters(db, stranger), false);

  const block: Block = {
    number: 500, hash: "0xa", parentHash: "0xb", timestamp: 1_800_000_500,
    transactions: [transfer(addr(90), launcher, 70_000_000_000_000_000n), transfer(addr(91), stranger, 5n)],
  };
  const found = FU.fundingsIn(db, block);
  assert.equal(found.length, 1, "445,000 transfers a day, and only the ones attached to a launch are worth a row");
  assert.equal(found[0].wallet, launcher);
  assert.equal(found[0].wei, "70000000000000000");
});

test("the same transfer read twice is one row, and a rewind does not double it", () => {
  const w = addr(10);
  const f = { tx: "0xdup", block: 600, ts: 1_800_000_600, funder: addr(92), wallet: w, wei: "5", fresh: null };
  FU.saveFunding(db, f);
  FU.saveFunding(db, { ...f, fresh: 1 });
  const rows = db.prepare("SELECT count(*) c, fresh FROM fundings WHERE tx = '0xdup'").get() as { c: number; fresh: number };
  assert.equal(rows.c, 1);
  assert.equal(rows.fresh, 1, "and a later read that could tell freshness fills in what the first could not");
});

test("freshness is only claimed where it is knowable", async () => {
  const calls: string[] = [];
  const rpc = async (method: string): Promise<string> => {
    calls.push(method);
    return "0x0";
  };
  assert.equal(await FU.freshAt(rpc, addr(5), 1000, 1200), true, "nonce zero and balance zero, near the head");
  assert.equal(calls.length, 2);

  calls.length = 0;
  assert.equal(await FU.freshAt(rpc, addr(5), 1000, 90_000), null,
    "state older than the window is not knowable, and a guess would be worse than a null");
  assert.equal(calls.length, 0, "and it is not even asked for");

  const used = async (): Promise<string> => "0x3";
  assert.equal(await FU.freshAt(used, addr(5), 1000, 1200), false);

  const broken = async (): Promise<string> => { throw new Error("metadata is not found"); };
  assert.equal(await FU.freshAt(broken, addr(5), 1000, 1200), null, "an endpoint refusing is not a fresh wallet");
});

test("a card asks for the last funding before the launch, not the first ever", () => {
  const w = addr(20);
  const launchTs = 1_800_100_000;
  FU.saveFunding(db, { tx: "0xold", block: 1, ts: launchTs - 80_000, funder: addr(93), wallet: w, wei: "1", fresh: 0 });
  FU.saveFunding(db, { tx: "0xnear", block: 2, ts: launchTs - 45, funder: addr(94), wallet: w, wei: "70000000000000000", fresh: 1 });

  const o = FU.originOf(db, w, launchTs)!;
  assert.equal(o.funder, addr(94));
  assert.equal(o.secondsBefore, 45, "forty-five seconds before the launch is the fact worth printing");
  assert.equal(o.fresh, true);

  assert.equal(FU.originOf(db, w, launchTs, 10), null,
    "and a card never claims a connection to money that arrived outside the window it asked about");
});

test("a funder that has fed other launchers is counted, and it excludes this wallet", () => {
  const funder = addr(95);
  const launchTs = 1_800_200_000;
  const others = [addr(30), addr(31)];
  const add = db.prepare(`INSERT INTO launches (token, curve, deployer, pair_token, launch_config_id,
    graduation_threshold_wei, graduation_threshold_eth, block, tx, log_index, ts, first_seen_at, launch_sender)
    VALUES (?,'0xc',?,'0x0000000000000000000000000000000000000000',1,'1',1,1,?,0,1,1,?)`);
  others.forEach((o, i) => add.run("0xfed" + i, o, "0xtxf" + i, o));

  const target = addr(32);
  add.run("0xfedt", target, "0xtxft", target);
  FU.saveFunding(db, { tx: "0xf1", block: 3, ts: launchTs - 100, funder, wallet: others[0], wei: "1", fresh: null });
  FU.saveFunding(db, { tx: "0xf2", block: 4, ts: launchTs - 90, funder, wallet: others[1], wei: "1", fresh: null });
  FU.saveFunding(db, { tx: "0xf3", block: 5, ts: launchTs - 10, funder, wallet: target, wei: "1", fresh: null });

  const o = FU.originOf(db, target, launchTs)!;
  assert.equal(o.funderFedLaunchers, 2, "an address that has fed two other launchers is a different fact from a one-off");
});

test("several funders converging on one wallet is its own shape", () => {
  const w = addr(40);
  const launchTs = 1_800_300_000;
  for (let i = 0; i < 4; i++) {
    FU.saveFunding(db, {
      tx: "0xfan" + i, block: 10 + i, ts: launchTs - 60 + i,
      funder: addr(50 + i), wallet: w, wei: "70000000000000000", fresh: null,
    });
  }
  const f = FU.fanIn(db, w, launchTs)!;
  assert.equal(f.funders, 4, "four addresses converging a minute before a launch is a launch being staged");

  assert.equal(FU.fanIn(db, addr(41), launchTs), null, "and one funder is just somebody being paid");
});
