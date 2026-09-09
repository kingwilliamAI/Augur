import { decodeEventLog, type Log } from "viem";
import { curveAbi, TOPIC } from "../abi.ts";
import { logsClient, sleep, withRetry } from "../chain.ts";
import { BlockClock } from "../blockclock.ts";
import { CFG } from "../config.ts";
import { getMeta, openDb, setMeta } from "../db.ts";
import { applyTrade, leaderboard } from "../traders.ts";
import { quoteFromCache } from "../quote.ts";

/**
 * augur traders — every curve trade on the chain, folded into who traded well.
 *
 * The stream is 623,000 buys and 510,000 sells a day, and none of it is kept. At the 490 bytes a
 * curve trade costs with its indexes, storing it would be more than half a gigabyte a day for rows
 * whose only use is three numbers per wallet and token. So each chunk of logs is folded into
 * positions and discarded, the same bargain the curve summaries already make.
 *
 * Read by topic across the whole chain rather than per curve. The existing curve indexer is
 * per-token and on demand, which is right for a card somebody opened and wrong for a question about
 * every wallet: asking for one token's logs 24,000 times a day is 24,000 requests, and asking for
 * every CurveBuy in a range is one.
 *
 * augur traders [--from N] [--hours N] [--chunk N] [--once]
 */

const argv = process.argv.slice(2);
const arg = (name: string, dflt: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const ONCE = argv.includes("--once");
const CHUNK = arg("chunk", 2000);
const HOURS = arg("hours", 0);

const db = openDb();
const CURSOR_KEY = "traders_to_block";

/**
 * Which token a curve belongs to.
 *
 * The events name the curve, not the token, and the map between them is in the launches table. Held
 * in memory because it is one row per launch and the alternative is a lookup per log: at a million
 * logs a day that is the difference between a map and a bottleneck. Refreshed as the sweep advances,
 * so curves created during a long run are not invisible for the rest of it.
 */
function curveMap(): Map<string, { token: string; pair: string }> {
  const m = new Map<string, { token: string; pair: string }>();
  for (const r of db.prepare("SELECT curve, token, pair_token FROM launches").all() as
    Array<{ curve: string; token: string; pair_token: string }>) {
    m.set(r.curve.toLowerCase(), { token: r.token, pair: r.pair_token });
  }
  return m;
}

let curves = curveMap();
const clock = new BlockClock();

const head = Number(await withRetry(() => logsClient.getBlockNumber()));
const stored = Number(getMeta(db, CURSOR_KEY) ?? 0);
const from = arg("from", 0)
  || (stored ? stored + 1 : HOURS ? head - Math.round(HOURS * 3600 * 9.91) : head - 20_000);

console.log("augur traders — curve trades, folded into records");
console.log(`  ${from.toLocaleString()} .. ${head.toLocaleString()}  (${(head - from).toLocaleString()} blocks)`);
console.log(`  ${curves.size.toLocaleString()} curves known\n`);

await clock.seed(from, head);

let logs = 0;
let folded = 0;
let unknown = 0;
let cursor = from;

while (cursor <= head) {
  const to = Math.min(head, cursor + CHUNK - 1);
  let batch: Log[];
  try {
    batch = await withRetry(() => logsClient.request({
      method: "eth_getLogs",
      params: [{
        fromBlock: `0x${cursor.toString(16)}`,
        toBlock: `0x${to.toString(16)}`,
        topics: [[TOPIC.curveBuy, TOPIC.curveSell]],
      }],
    } as never)) as Log[];
  } catch (e) {
    console.log(`  ${cursor.toLocaleString()}: ${(e as Error).message.slice(0, 80)}`);
    await sleep(CFG.logsSpacingMs * 4);
    continue;
  }

  for (const l of batch) {
    const curve = curves.get(String(l.address).toLowerCase());
    if (!curve) { unknown++; continue; }
    logs++;

    let ev: ReturnType<typeof decodeEventLog>;
    try {
      ev = decodeEventLog({ abi: curveAbi, topics: l.topics as [`0x${string}`, ...`0x${string}`[]], data: l.data! });
    } catch { continue; }

    const a = ev.args as Record<string, unknown>;
    const buy = ev.eventName === "CurveBuy";
    // The recipient rather than the caller: a router buying on somebody's behalf is not the trader,
    // and the recipient is the wallet that ends up holding the position.
    const wallet = String(buy ? a.recipient : a.seller ?? a.recipient).toLowerCase();
    const q = quoteFromCache(db, curve.pair);
    const scale = 10 ** q.decimals;
    const quote = Number(BigInt(String(buy ? a.quoteIn : a.quoteOut))) / scale;
    const tokens = Number(BigInt(String(buy ? a.tokensOut : a.tokensIn))) / 1e18;

    applyTrade(db, {
      wallet, token: curve.token, side: buy ? "buy" : "sell",
      quote, tokens, ts: await clock.at(Number(l.blockNumber)),
    });
    folded++;
  }

  cursor = to + 1;
  // Checkpointed per chunk. A sweep measured in hours that saves only at the end throws everything
  // away when it is interrupted at minute eighty, which is the bug the pool indexer already learned.
  setMeta(db, CURSOR_KEY, String(to));
  if ((to - from) % (CHUNK * 25) < CHUNK) {
    curves = curveMap();
    console.log(`  ${to.toLocaleString()}  ${folded.toLocaleString()} trades folded, ${unknown.toLocaleString()} on curves not in the database`);
  }
  await sleep(CFG.logsSpacingMs);
  if (ONCE) break;
}

const top = leaderboard(db, { limit: 10 });
console.log(`\nfolded ${folded.toLocaleString()} trades from ${logs.toLocaleString()} logs`);
console.log(`${top.length} wallet(s) with enough of a record to rank\n`);
for (const t of top.slice(0, 10)) {
  console.log(`  ${t.wallet.slice(0, 12)}…  $${Math.round(t.realisedUsd).toLocaleString()}`
    + `  ${t.closed} closed, ${(100 * t.winRate).toFixed(0)}% up, best ${t.bestMultiple.toFixed(1)}x`);
}
db.close();
