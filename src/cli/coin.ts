import { logsClient, withRetry } from "../chain.ts";
import { getMeta, openDb, setMeta } from "../db.ts";
import { indexCoinBars } from "../pool.ts";
import { CFG } from "../config.ts";

/**
 * Keeps the coin page's chart current.
 *
 * The chain-wide swap pass folds every pool to a high, low and last, which is the only affordable
 * shape for four thousand of them. The one pool this site is about wants something else: a series.
 * Asking the endpoint for a single pool id lets a chunk cover a hundred and fifty thousand blocks
 * instead of a thousand, so its whole history is a couple of dozen reads rather than five hundred.
 *
 * Resumable: the covered range is checkpointed, and a run with nothing new to read stops at once.
 *
 * augur coin [--chunk N] [--from-launch]
 */
const argv = process.argv.slice(2);
const arg = (name: string, dflt: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const chunk = arg("chunk", 150_000);
const fromLaunch = argv.includes("--from-launch");

const db = openDb();
const tok = CFG.coinToken;
if (!tok) {
  console.log("no COIN_TOKEN configured; nothing to follow");
  db.close();
  process.exit(0);
}

const pool = db.prepare("SELECT pool_id, token_is_c1, init_block FROM pools WHERE token = ?").get(tok) as
  | { pool_id: string; token_is_c1: number; init_block: number } | undefined;
if (!pool) {
  console.log(`no pons pool on record for ${tok}`);
  console.log("run: npm run pools    (it resolves every graduated token's pool)");
  db.close();
  process.exit(1);
}

const head = Number(await withRetry(() => logsClient.getBlockNumber()));
const key = `coin_bars_to_block:${pool.pool_id}`;
const saved = Number(getMeta(db, key) ?? 0);
const from = fromLaunch || saved === 0 ? pool.init_block : saved + 1;

if (from > head) {
  console.log(`already current at block ${saved.toLocaleString()}`);
  db.close();
  process.exit(0);
}

const span = head - from + 1;
console.log(`coin ${tok}`);
console.log(`pool ${pool.pool_id}`);
console.log(`reading swaps over ${span.toLocaleString()} blocks (${from.toLocaleString()}..${head.toLocaleString()})\n`);

const t0 = Date.now();
const r = await indexCoinBars(
  db,
  { poolId: pool.pool_id, tokenIsC1: pool.token_is_c1 === 1 },
  from,
  head,
  chunk,
  (upTo, swaps) => {
    setMeta(db, key, String(upTo));
    const done = upTo - from + 1;
    process.stdout.write(`\r  ${((100 * done) / span).toFixed(1)}%  ${swaps.toLocaleString()} swaps  `);
  },
);
setMeta(db, key, String(head));

const bars = (db.prepare("SELECT count(*) c FROM coin_bars WHERE pool_id = ?").get(pool.pool_id) as { c: number }).c;
console.log(`\r  ${r.swaps.toLocaleString()} swaps in ${r.chunks} reads, ${((Date.now() - t0) / 1000).toFixed(1)}s${" ".repeat(20)}`);
console.log(`  ${bars.toLocaleString()} bars on record`);
db.close();
