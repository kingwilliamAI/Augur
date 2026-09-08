import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The bug these guard was silent and cost two orders of magnitude.
 *
 * `seed` used to space anchors at `max(maxGap, range / 64)`, which exceeds `maxGap` on any range
 * wider than 64 * maxGap. `at` refuses to interpolate across a gap that wide, so past that
 * threshold every single log's timestamp fell through to its own `eth_getBlockByNumber`. Nothing
 * failed and nothing was logged: a 7-day backfill simply took ten hours instead of five minutes.
 *
 * So the assertion that matters is not "the timestamps are right" but "the network was not
 * touched". Counting RPC calls is the only way to see this class of regression.
 */

// The gate's default 60 ms spacing would stretch 300 stubbed calls into 18 seconds of test time.
process.env.RPC_SPACING_MS = "0";
process.env.RPC_IN_FLIGHT = "16";

const GENESIS_TS = 1_700_000_000;
/** The measured block time this chain is assumed to run at. */
const SEC_PER_BLOCK = 0.1009;
/** What `backfill --hours 168` covers, which is the range that used to trip the bug. */
const WEEK_OF_BLOCKS = 6_000_000;

const realTimestamp = (block: number): number => Math.round(GENESIS_TS + block * SEC_PER_BLOCK);

let blockReads = 0;

globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
  const parsed = JSON.parse(String(init.body)) as
    | { id: number; method: string; params: [string, boolean] }
    | Array<{ id: number; method: string; params: [string, boolean] }>;
  const calls = Array.isArray(parsed) ? parsed : [parsed];

  const replies = calls.map((c) => {
    assert.equal(c.method, "eth_getBlockByNumber", `BlockClock made an unexpected ${c.method} call`);
    blockReads++;
    const ts = realTimestamp(Number(BigInt(c.params[0])));
    return { jsonrpc: "2.0", id: c.id, result: { number: c.params[0], timestamp: `0x${ts.toString(16)}` } };
  });

  return new Response(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

// Imported dynamically so the env above is in place before config.ts reads it.
const { BlockClock } = await import("./blockclock.ts");

test("seeding a week costs a few hundred reads, not one per block", async () => {
  blockReads = 0;
  const clock = new BlockClock();
  await clock.seed(0, WEEK_OF_BLOCKS);

  assert.ok(
    blockReads > 0 && blockReads < 400,
    `expected a few hundred anchor reads for a week of blocks, got ${blockReads}`,
  );
});

test("after seeding, at() answers from anchors and never goes back to the network", async () => {
  const clock = new BlockClock();
  await clock.seed(0, WEEK_OF_BLOCKS);
  const afterSeed = blockReads;

  // A prime stride so the probes land at arbitrary offsets inside the anchor intervals rather
  // than repeatedly hitting anchors themselves.
  for (let b = 0; b <= WEEK_OF_BLOCKS; b += 7919) await clock.at(b);

  assert.equal(
    blockReads,
    afterSeed,
    `at() went to the network ${blockReads - afterSeed} times for blocks it should have interpolated`,
  );
});

test("interpolated timestamps land on the real block time", async () => {
  const clock = new BlockClock();
  await clock.seed(0, WEEK_OF_BLOCKS);

  for (const block of [1, 9_999, 123_457, 3_000_001, 5_999_999]) {
    const got = await clock.at(block);
    assert.ok(
      Math.abs(got - realTimestamp(block)) <= 2,
      `block ${block}: interpolated ${got}, real ${realTimestamp(block)}`,
    );
  }
});

test("a narrow range still seeds and interpolates", async () => {
  const clock = new BlockClock();
  await clock.seed(1_000_000, 1_005_000);
  const afterSeed = blockReads;

  for (let b = 1_000_000; b <= 1_005_000; b += 137) await clock.at(b);

  assert.equal(blockReads, afterSeed, "a range narrower than one anchor step should need no extra reads");
});
