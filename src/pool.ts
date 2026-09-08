import { decodeEventLog, toEventSelector, type Log } from "viem";
import { ADDR } from "./config.ts";
import { logsClient, sleep, withRetry } from "./chain.ts";
import { marketCapUsd, SUPPLY } from "./prices.ts";
import type { DB } from "./db.ts";

/**
 * What a token does after it leaves the curve.
 *
 * The curve is only the first act. A launch that graduates has by definition reached the threshold,
 * so its curve peak is very nearly a constant: measured across graduated tokens it lands between
 * $45K and $59K because that is the bar it had to clear. Everything that distinguishes one graduated
 * token from another happens afterwards, in the pool, and until now none of it was recorded. On four
 * sampled tokens the pool peak ran between 2.2x and 50.6x the curve peak; SNOWBALL reached
 * $2,700,516 against the $53,357 the curve knew about.
 *
 * Uniswap v4 makes this cheaper to follow than the curves were. Every pool on the chain lives inside
 * one singleton contract, so a single log stream carries every graduated token at once, where curves
 * needed one read per token. And each `Swap` carries `sqrtPriceX96`, so the price is in the event
 * rather than something to reconstruct from reserves.
 *
 * Measured: a 2,000-block chunk returns about 8,400 logs in 1.7 s and covers 202 seconds of chain,
 * so keeping up with every graduated token costs roughly 430 reads a day. The curve indexer already
 * runs at 1.7 reads a second.
 */

export const TOPIC_POOL_INIT = toEventSelector(
  "Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)",
);
export const TOPIC_POOL_SWAP = toEventSelector(
  "Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)",
);

/**
 * The pons hook's fee sweep, identified by matching its totals against a public page.
 *
 * Its signature is not published anywhere we can read, so it is pinned by topic rather than derived
 * from a name. What is known is checkable: the event is keyed by pool id, and the third word of its
 * data summed to 73.713673 ETH over one token's 319 sweeps against the 74.164802 ETH that token's
 * pons page reports across 331. The gap is the twelve sweeps outside the block range read.
 */
export const TOPIC_HOOK_SWEEP =
  "0x2f3c43579b9064b6f28edcf41608f3815792d274a56afe024359703cb4ea9b30" as const;

const initAbi = [{
  type: "event", name: "Initialize", inputs: [
    { name: "id", type: "bytes32", indexed: true },
    { name: "currency0", type: "address", indexed: true },
    { name: "currency1", type: "address", indexed: true },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
    { name: "sqrtPriceX96", type: "uint160" },
    { name: "tick", type: "int24" },
  ],
}] as const;

const swapAbi = [{
  type: "event", name: "Swap", inputs: [
    { name: "id", type: "bytes32", indexed: true },
    { name: "sender", type: "address", indexed: true },
    { name: "amount0", type: "int128" },
    { name: "amount1", type: "int128" },
    { name: "sqrtPriceX96", type: "uint160" },
    { name: "liquidity", type: "uint128" },
    { name: "tick", type: "int24" },
    { name: "fee", type: "uint24" },
  ],
}] as const;

type RawLog = Log & { topics: [`0x${string}`, ...`0x${string}`[]]; data: `0x${string}` };

const Q96 = 2 ** 96;
/** Every token pons launches carries eighteen decimals, the same as the supply figure assumes. */
const TOKEN_DECIMALS = 18;

export type PoolRow = {
  token: string; pool_id: string; currency0: string; currency1: string;
  token_is_c1: number; dec0: number; dec1: number; init_block: number; init_sqrt: string;
};


/**
 * Every pons pool opened in a block range, found in one sweep rather than one search per token.
 *
 * Resolution used to ask the PoolManager about a single token at a time across a wide window. That
 * is the expensive way round, and measurably so: the per-token query costs 1,619 ms and comes back
 * with nothing, while the same query with the token slot left open costs 1,385 ms and comes back
 * with 541 pools. The singleton already carries every pool, so pinning one token buys no reduction
 * in work, it only narrows what the same scan is allowed to return. Three thousand tokens at two
 * calls each runs to two and a half hours; sweeping the same history once takes about four minutes.
 *
 * It also cannot miss, which the old way could. A per-token window that guessed wrong reported "no
 * pons pool" for a token whose pool had simply opened outside it, and that is what put roughly 8% of
 * graduated tokens in that bucket rather than anything real about them.
 *
 * `quoteDecimalsFor` is passed in rather than imported so this module keeps knowing only about
 * pools; the caller already holds the quote-asset cache.
 */
export async function resolvePoolsSweep(
  db: DB,
  fromBlock: number,
  toBlock: number,
  chunk: number,
  quoteDecimalsFor: (pairToken: string) => number,
  onChunk?: (upTo: number, found: number) => void,
): Promise<{ found: number; chunks: number }> {
  const launch = db.prepare("SELECT token, pair_token FROM launches WHERE token = ?");
  const ins = db.prepare(`
    INSERT INTO pools (token, pool_id, currency0, currency1, token_is_c1, dec0, dec1, init_block, init_sqrt)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(token) DO NOTHING`);

  let found = 0, chunks = 0;
  for (let from = fromBlock; from <= toBlock; from += chunk) {
    const to = Math.min(toBlock, from + chunk - 1);
    const logs = (await withRetry(() => logsClient.request({
      method: "eth_getLogs",
      params: [{
        address: ADDR.v4PoolManager,
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${to.toString(16)}`,
        topics: [TOPIC_POOL_INIT],
      }],
    } as never))) as RawLog[];
    chunks++;

    for (const l of logs) {
      let a: Record<string, unknown>;
      try {
        a = decodeEventLog({ abi: initAbi, topics: l.topics, data: l.data }).args as Record<string, unknown>;
      } catch {
        continue;
      }
      if (String(a.hooks).toLowerCase() !== ADDR.hook.toLowerCase()) continue;

      // One side of the pair is the launched token and the other is what it trades against; which is
      // which follows from address order, so both are looked up rather than assumed.
      const c0 = String(a.currency0).toLowerCase();
      const c1 = String(a.currency1).toLowerCase();
      const asC1 = launch.get(c1) as { token: string; pair_token: string } | undefined;
      const asC0 = asC1 ? undefined : (launch.get(c0) as { token: string; pair_token: string } | undefined);
      const row = asC1 ?? asC0;
      if (!row) continue;

      const isC1 = asC1 ? 1 : 0;
      const qd = quoteDecimalsFor(row.pair_token);
      ins.run(
        row.token, String(a.id), c0, c1, isC1,
        isC1 ? qd : TOKEN_DECIMALS, isC1 ? TOKEN_DECIMALS : qd,
        Number(l.blockNumber), (a.sqrtPriceX96 as bigint).toString(),
      );
      found++;
    }
    onChunk?.(to, found);
  }
  return { found, chunks };
}

/**
 * Whole quote units per whole token, from a pool price.
 *
 * `sqrtPriceX96` squares to currency1 per currency0 in raw units, so which side the token sits on
 * decides whether the ratio is inverted, and the decimal gap between the two currencies has to be
 * put back either way.
 */
export function quotePerToken(sqrt: string | bigint, p: Pick<PoolRow, "token_is_c1" | "dec0" | "dec1">): number {
  const r = Number(sqrt) / Q96;
  const price = r * r;
  if (!(price > 0) || !Number.isFinite(price)) return 0;
  return p.token_is_c1 ? (1 / price) * 10 ** (p.dec1 - p.dec0) : price * 10 ** (p.dec0 - p.dec1);
}

/**
 * Reads pool swaps chain-wide and keeps only the extremes.
 *
 * Three and a half million swaps a day pass through the singleton, and storing them would buy
 * nothing: the card asks how high a token went, which is one number per pool. So each chunk updates
 * a running high and low per pool and is then discarded.
 *
 * Both ends are kept because the token is not always the same side of the pair. Where it is
 * currency1 the price rises as `sqrtPriceX96` falls, so its peak is the low; where it is currency0
 * the peak is the high. Storing one end would silently invert half the pools.
 */
/** Roughly five minutes of chain at 0.1009s a block, so a day of the coin page is 288 bars. */
export const BAR_BLOCKS = 3000;

export async function indexPoolSwaps(
  db: DB, fromBlock: number, toBlock: number, chunk = 2000,
  onChunk?: (upTo: number, swaps: number) => void,
  spacingMs = 0,
  /** Pools to keep a time series for. One, in practice: the coin this site is about. */
  barPool?: { poolId: string; tokenIsC1: boolean } | null,
): Promise<{ swaps: number; matched: number; chunks: number }> {
  const known = new Set<string>(
    (db.prepare("SELECT pool_id FROM pools").all() as Array<{ pool_id: string }>).map((r) => r.pool_id),
  );
  if (!known.size) return { swaps: 0, matched: 0, chunks: 0 };

  const upsert = db.prepare(`
    INSERT INTO pool_peaks (pool_id, min_sqrt, max_sqrt, min_block, max_block, last_sqrt, last_block, swaps, to_block)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(pool_id) DO UPDATE SET
      min_sqrt  = CASE WHEN CAST(excluded.min_sqrt AS REAL) < CAST(pool_peaks.min_sqrt AS REAL) THEN excluded.min_sqrt ELSE pool_peaks.min_sqrt END,
      min_block = CASE WHEN CAST(excluded.min_sqrt AS REAL) < CAST(pool_peaks.min_sqrt AS REAL) THEN excluded.min_block ELSE pool_peaks.min_block END,
      max_sqrt  = CASE WHEN CAST(excluded.max_sqrt AS REAL) > CAST(pool_peaks.max_sqrt AS REAL) THEN excluded.max_sqrt ELSE pool_peaks.max_sqrt END,
      max_block = CASE WHEN CAST(excluded.max_sqrt AS REAL) > CAST(pool_peaks.max_sqrt AS REAL) THEN excluded.max_block ELSE pool_peaks.max_block END,
      last_sqrt = excluded.last_sqrt,
      last_block = excluded.last_block,
      swaps     = pool_peaks.swaps + excluded.swaps,
      to_block  = excluded.to_block`);

  const bar = db.prepare(`
    INSERT INTO coin_bars (pool_id, bucket, open_sqrt, hi_sqrt, lo_sqrt, close_sqrt, swaps, vol_quote, fee_quote, liquidity, last_block)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(pool_id, bucket) DO UPDATE SET
      hi_sqrt    = CASE WHEN CAST(excluded.hi_sqrt AS REAL) > CAST(coin_bars.hi_sqrt AS REAL) THEN excluded.hi_sqrt ELSE coin_bars.hi_sqrt END,
      lo_sqrt    = CASE WHEN CAST(excluded.lo_sqrt AS REAL) < CAST(coin_bars.lo_sqrt AS REAL) THEN excluded.lo_sqrt ELSE coin_bars.lo_sqrt END,
      close_sqrt = excluded.close_sqrt,
      swaps      = coin_bars.swaps + excluded.swaps,
      vol_quote  = CAST(CAST(coin_bars.vol_quote AS REAL) + CAST(excluded.vol_quote AS REAL) AS TEXT),
      fee_quote  = CAST(CAST(coin_bars.fee_quote AS REAL) + CAST(excluded.fee_quote AS REAL) AS TEXT),
      liquidity  = excluded.liquidity,
      last_block = excluded.last_block`);

  let swaps = 0, matched = 0, chunks = 0;
  let from = fromBlock;
  let width = chunk;

  while (from <= toBlock) {
    const to = Math.min(toBlock, from + width - 1);
    let logs: RawLog[];
    try {
      logs = (await withRetry(() => logsClient.request({
        method: "eth_getLogs",
        params: [{
          address: ADDR.v4PoolManager,
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${to.toString(16)}`,
          topics: [TOPIC_POOL_SWAP],
        }],
      } as never))) as RawLog[];
    } catch (e) {
      // The endpoint caps a response at 10,000 logs, and pool activity is bursty enough that a width
      // which fit an hour ago can stop fitting. Halving and retrying costs one wasted read.
      if (width > 125) { width = Math.floor(width / 2); continue; }
      throw e;
    }
    // And widen again once the burst is past. Without this one busy stretch narrowed the window for
    // the whole remaining run, so a single spike early in a six-million-block sweep taxed every
    // block after it.
    if (logs.length < 4000 && width < chunk) width = Math.min(chunk, width * 2);
    chunks++;
    swaps += logs.length;

    // Folded in memory first: one row per pool per chunk instead of one write per swap.
    const agg = new Map<string, { lo: bigint; hi: bigint; loB: number; hiB: number; last: bigint; lastB: number; n: number }>();
    const bars: Array<{ bucket: number; sqrt: bigint; blk: number; vol: number; fee: number; liq: string }> = [];
    for (const l of logs) {
      const id = l.topics[1];
      if (!id || !known.has(id)) continue;
      let a: Record<string, unknown>;
      try {
        a = decodeEventLog({ abi: swapAbi, topics: l.topics, data: l.data }).args as Record<string, unknown>;
      } catch {
        continue;
      }
      const sqrt = a.sqrtPriceX96 as bigint;
      if (sqrt <= 0n) continue;
      const blk = Number(l.blockNumber);
      const cur = agg.get(id);
      matched++;

      if (barPool && id === barPool.poolId) {
        // Volume is measured on the quote side, which every swap reports whichever way it went, and
        // the fee is that volume at the pool's own rate. `fee` is in hundredths of a bip.
        const q = barPool.tokenIsC1 ? (a.amount0 as bigint) : (a.amount1 as bigint);
        const vol = q < 0n ? -q : q;
        const rate = Number(a.fee as number | bigint);
        bars.push({
          bucket: Math.floor(blk / BAR_BLOCKS),
          sqrt, blk,
          vol: Number(vol),
          fee: (Number(vol) * rate) / 1e6,
          liq: (a.liquidity as bigint).toString(),
        });
      }
      if (!cur) {
        agg.set(id, { lo: sqrt, hi: sqrt, loB: blk, hiB: blk, last: sqrt, lastB: blk, n: 1 });
        continue;
      }
      if (sqrt < cur.lo) { cur.lo = sqrt; cur.loB = blk; }
      if (sqrt > cur.hi) { cur.hi = sqrt; cur.hiB = blk; }
      cur.last = sqrt; cur.lastB = blk; cur.n++;
    }

    if (agg.size) {
      db.exec("BEGIN");
      try {
        for (const [id, v] of agg) {
          upsert.run(id, v.lo.toString(), v.hi.toString(), v.loB, v.hiB, v.last.toString(), v.lastB, v.n, to);
        }
        // One row per bucket per chunk, so a chunk spanning two buckets writes both and a bucket
        // spanning two chunks is merged by the upsert rather than replaced.
        if (barPool && bars.length) {
          const byBucket = new Map<number, typeof bars>();
          for (const b of bars) {
            const list = byBucket.get(b.bucket);
            if (list) list.push(b); else byBucket.set(b.bucket, [b]);
          }
          for (const [bucket, list] of byBucket) {
            let hi = list[0].sqrt, lo = list[0].sqrt, vol = 0, fee = 0;
            for (const b of list) { if (b.sqrt > hi) hi = b.sqrt; if (b.sqrt < lo) lo = b.sqrt; vol += b.vol; fee += b.fee; }
            const last = list[list.length - 1];
            bar.run(barPool.poolId, bucket, list[0].sqrt.toString(), hi.toString(), lo.toString(),
              last.sqrt.toString(), list.length, String(vol), String(fee), last.liq, last.blk);
          }
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
    from = to + 1;
    onChunk?.(to, swaps);
    // A pause between chunks, because the endpoint eventually stops answering a sweep that never
    // pauses. Hours of back-to-back reads earned a 403, which killed this pass and, worse, starved
    // the cards: a reader waiting on one curve got the same refusal and sat on "reading" forever.
    if (spacingMs > 0) await sleep(spacingMs);
  }
  return { swaps, matched, chunks };
}

/**
 * Reads one pool's whole swap history into bars.
 *
 * The chain-wide pass is the right shape for four thousand pools and the wrong shape for one: it
 * has to walk every block in narrow chunks because the singleton carries every pool's traffic. Asked
 * about a single pool, the endpoint will filter by the id in the topic, and then a chunk can be
 * enormous. Measured against this endpoint, one id over 200,000 blocks came back in about a second.
 *
 * That is what makes a real chart affordable for the coin page: half a million blocks of history in
 * a couple of dozen reads instead of five hundred.
 */
export async function indexCoinBars(
  db: DB,
  pool: { poolId: string; tokenIsC1: boolean },
  fromBlock: number,
  toBlock: number,
  chunk = 150_000,
  onChunk?: (upTo: number, swaps: number) => void,
): Promise<{ swaps: number; chunks: number; bars: number }> {
  const bar = db.prepare(`
    INSERT INTO coin_bars (pool_id, bucket, open_sqrt, hi_sqrt, lo_sqrt, close_sqrt, swaps, vol_quote, fee_quote, liquidity, last_block)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(pool_id, bucket) DO UPDATE SET
      hi_sqrt    = CASE WHEN CAST(excluded.hi_sqrt AS REAL) > CAST(coin_bars.hi_sqrt AS REAL) THEN excluded.hi_sqrt ELSE coin_bars.hi_sqrt END,
      lo_sqrt    = CASE WHEN CAST(excluded.lo_sqrt AS REAL) < CAST(coin_bars.lo_sqrt AS REAL) THEN excluded.lo_sqrt ELSE coin_bars.lo_sqrt END,
      close_sqrt = excluded.close_sqrt,
      swaps      = coin_bars.swaps + excluded.swaps,
      vol_quote  = CAST(CAST(coin_bars.vol_quote AS REAL) + CAST(excluded.vol_quote AS REAL) AS TEXT),
      fee_quote  = CAST(CAST(coin_bars.fee_quote AS REAL) + CAST(excluded.fee_quote AS REAL) AS TEXT),
      liquidity  = excluded.liquidity,
      last_block = excluded.last_block`);

  const sweepIns = db.prepare(
    "INSERT INTO coin_sweeps (pool_id, block, log_index, fee_quote, other) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING",
  );

  let swaps = 0, chunks = 0, written = 0;
  let from = fromBlock;
  let width = chunk;

  while (from <= toBlock) {
    const to = Math.min(toBlock, from + width - 1);
    let logs: RawLog[];
    try {
      logs = (await withRetry(() => logsClient.request({
        method: "eth_getLogs",
        params: [{
          address: ADDR.v4PoolManager,
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${to.toString(16)}`,
          topics: [TOPIC_POOL_SWAP, [pool.poolId]],
        }],
      } as never))) as RawLog[];
    } catch (e) {
      if (width > 2000) { width = Math.floor(width / 2); continue; }
      throw e;
    }
    chunks++;
    swaps += logs.length;

    const byBucket = new Map<number, { open: bigint; hi: bigint; lo: bigint; close: bigint; n: number; vol: number; fee: number; liq: string; blk: number }>();
    for (const l of logs) {
      let a: Record<string, unknown>;
      try {
        a = decodeEventLog({ abi: swapAbi, topics: l.topics, data: l.data }).args as Record<string, unknown>;
      } catch {
        continue;
      }
      const sqrt = a.sqrtPriceX96 as bigint;
      if (sqrt <= 0n) continue;
      const blk = Number(l.blockNumber);
      const bucket = Math.floor(blk / BAR_BLOCKS);
      // Volume is read off the quote side, which every swap reports whichever way it went, and the
      // fee is that volume at the pool's own rate. `fee` is in hundredths of a bip.
      const qraw = pool.tokenIsC1 ? (a.amount0 as bigint) : (a.amount1 as bigint);
      const vol = Number(qraw < 0n ? -qraw : qraw);
      const fee = (vol * Number(a.fee as number | bigint)) / 1e6;
      const liq = (a.liquidity as bigint).toString();

      const cur = byBucket.get(bucket);
      if (!cur) { byBucket.set(bucket, { open: sqrt, hi: sqrt, lo: sqrt, close: sqrt, n: 1, vol, fee, liq, blk }); continue; }
      if (sqrt > cur.hi) cur.hi = sqrt;
      if (sqrt < cur.lo) cur.lo = sqrt;
      cur.close = sqrt; cur.n++; cur.vol += vol; cur.fee += fee; cur.liq = liq; cur.blk = blk;
    }

    if (byBucket.size) {
      db.exec("BEGIN");
      try {
        for (const [bucket, v] of byBucket) {
          bar.run(pool.poolId, bucket, v.open.toString(), v.hi.toString(), v.lo.toString(),
            v.close.toString(), v.n, String(v.vol), String(v.fee), v.liq, v.blk);
          written++;
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
    // Fees are swept, not charged per swap, so they come from the hook rather than the pool and are
    // read over the same range in the same pass.
    try {
      const sweeps = (await withRetry(() => logsClient.request({
        method: "eth_getLogs",
        params: [{
          address: ADDR.hook,
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${to.toString(16)}`,
          topics: [TOPIC_HOOK_SWEEP, pool.poolId],
        }],
      } as never))) as RawLog[];
      if (sweeps.length) {
        db.exec("BEGIN");
        try {
          for (const l of sweeps) {
            const d = String(l.data).slice(2);
            if (d.length < 192) continue;
            sweepIns.run(
              pool.poolId, Number(l.blockNumber), Number(l.logIndex),
              BigInt("0x" + d.slice(128, 192)).toString(),
              BigInt("0x" + d.slice(0, 64)).toString(),
            );
          }
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      }
    } catch {
      // A sweep read that fails leaves the bars alone; the next run covers the same range again.
    }

    from = to + 1;
    onChunk?.(to, swaps);
  }
  return { swaps, chunks, bars: written };
}

export type PoolCaps = {
  poolId: string;
  openUsd: number | null;
  peakUsd: number | null;
  lastUsd: number | null;
  peakBlock: number | null;
  swaps: number;
};

/** What a token reached in the pool, in dollars, or null when its pool has not been read. */
export function poolCaps(db: DB, token: string, quoteSymbol: string | null): PoolCaps | null {
  const p = db.prepare("SELECT * FROM pools WHERE token = ?").get(token) as PoolRow | undefined;
  if (!p) return null;
  const k = db.prepare("SELECT * FROM pool_peaks WHERE pool_id = ?").get(p.pool_id) as
    | { min_sqrt: string; max_sqrt: string; min_block: number; max_block: number; last_sqrt: string; swaps: number }
    | undefined;

  const cap = (sqrt: string): number | null => marketCapUsd(quotePerToken(sqrt, p), quoteSymbol);
  if (!k) return { poolId: p.pool_id, openUsd: cap(p.init_sqrt), peakUsd: null, lastUsd: null, peakBlock: null, swaps: 0 };

  // The token's price peaks where its own side of the pair is dearest, which is the low end of the
  // ratio when it is currency1 and the high end when it is currency0.
  const peakSqrt = p.token_is_c1 ? k.min_sqrt : k.max_sqrt;
  const peakBlock = p.token_is_c1 ? k.min_block : k.max_block;
  const open = cap(p.init_sqrt);
  const peak = cap(peakSqrt);

  // `pool_peaks` is written by the chain-wide pass, which is millions of blocks behind head. Where a
  // coin has its own bars they are current, and a day-old price on the page that quotes a price is
  // the one number nobody should have to discount. This showed $1.28M for a token trading at $128K.
  const bar = db.prepare(
    "SELECT close_sqrt, hi_sqrt, lo_sqrt FROM coin_bars WHERE pool_id = ? ORDER BY bucket DESC LIMIT 1",
  ).get(p.pool_id) as { close_sqrt: string; hi_sqrt: string; lo_sqrt: string } | undefined;
  const fresh = bar ? cap(bar.close_sqrt) : null;

  // The peak has to see both stores too, since each covers a range the other may not.
  const barPeak = db.prepare(
    `SELECT ${p.token_is_c1 ? "min(lo_sqrt)" : "max(hi_sqrt)"} s FROM coin_bars WHERE pool_id = ?`,
  ).get(p.pool_id) as { s: string | null } | undefined;
  const barPeakUsd = barPeak?.s ? cap(barPeak.s) : null;

  const best = [peak, open, barPeakUsd].filter((v): v is number => v !== null);

  return {
    poolId: p.pool_id,
    openUsd: open,
    // The pool opens at the price the curve ended on, so that opening is itself a candidate peak for
    // a token nobody bought afterwards.
    peakUsd: best.length ? Math.max(...best) : null,
    lastUsd: fresh ?? cap(k.last_sqrt),
    peakBlock,
    swaps: k.swaps,
  };
}

export { SUPPLY };

/**
 * What a launch is worth at the moment it graduates, measured rather than quoted.
 *
 * The number readers actually need to place a forecast against. "Peak $7K" says nothing on its own;
 * "peak $7K, and it takes about $47K to graduate" says the model expects this one not to make it.
 *
 * It is close to a constant, which is what makes it usable: across 3,497 pool openings the median is
 * $46,957 with a tenth-to-ninetieth spread of $39,369 to $51,862, a ratio of 1.32. That is because a
 * pool opens at the price the curve ended on, and the curve ends when the threshold is cleared.
 *
 * Cached for an hour. It moves only as quote-asset prices move, and it costs a scan of every pool.
 */
let gradCap: { at: number; v: number | null; byAsset: Map<string, number> } | null = null;

export function graduationCapUsd(
  db: DB,
  quoteDecimalsFor: (pairToken: string) => number,
  symbolFor: (pairToken: string) => string | null,
  quoteSymbol?: string | null,
): number | null {
  if (!gradCap || Date.now() - gradCap.at >= 3_600_000) gradCap = { at: Date.now(), v: null, byAsset: new Map() };
  else if (quoteSymbol === undefined) return gradCap.v;
  else if (gradCap.v !== null) return gradCap.byAsset.get(quoteSymbol ?? "") ?? gradCap.v;

  const rows = db.prepare(
    "SELECT p.init_sqrt, p.token_is_c1, p.dec0, p.dec1, l.pair_token FROM pools p JOIN launches l USING(token)",
  ).all() as Array<PoolRow & { pair_token: string }>;

  const caps: number[] = [];
  const perAsset = new Map<string, number[]>();
  for (const p of rows) {
    const sym = symbolFor(p.pair_token);
    const cap = marketCapUsd(quotePerToken(p.init_sqrt, p), sym);
    if (cap === null || !Number.isFinite(cap) || cap <= 0) continue;
    caps.push(cap);
    if (sym) {
      const list = perAsset.get(sym);
      if (list) list.push(cap); else perAsset.set(sym, [cap]);
    }
  }
  caps.sort((a, b) => a - b);
  const v = caps.length >= 50 ? caps[Math.floor(caps.length / 2)] : null;

  // Per asset as well as overall, because the two differ by more than rounding: the global median is
  // $41K while an ETH-quoted launch graduates at $52K and a TTWO-quoted one at $28K. Quoting the
  // global figure to an ETH launch understates its bar by a fifth, which is exactly the sort of
  // "roughly right" that makes a reader stop trusting the specific numbers around it.
  const byAsset = new Map<string, number>();
  for (const [sym, list] of perAsset) {
    if (list.length < 5) continue;
    list.sort((a, b) => a - b);
    byAsset.set(sym, list[Math.floor(list.length / 2)]);
  }

  gradCap = { at: Date.now(), v, byAsset };
  return quoteSymbol === undefined ? v : byAsset.get(quoteSymbol ?? "") ?? v;
}

/**
 * Graduation expressed as a multiple of the opening price, needing no dollar price at all.
 *
 * The dollar anchor only works for quote assets the price book covers, and it does not cover them
 * all: 9.7% of a week's launches are quoted in something with no price, and for those the forecast
 * was being dropped rather than shown in the unit the model actually predicts. This is the same
 * anchor in that unit, and it is a protocol constant rather than a market one, so it holds across
 * every asset: measured on 174 graduated tokens the median is x10.9, with a tenth-to-ninetieth range
 * of x7.7 to x11.8.
 */
let gradMult: { at: number; v: number | null } | null = null;

export function graduationMultiple(db: DB): number | null {
  if (gradMult && Date.now() - gradMult.at < 3_600_000) return gradMult.v;

  // The summary arm is not an optimisation. This figure is measured across every graduated token
  // ever read, and compaction removes their trades within days of the launch; on trades alone the
  // constant would quietly narrow to whatever graduated this week.
  const rows = db.prepare(`
    WITH firsts AS (
      SELECT token, CAST(quote_wei AS REAL) / CAST(token_amt AS REAL) px,
             row_number() OVER (PARTITION BY token ORDER BY block, log_index) rn
      FROM curve_trades WHERE CAST(token_amt AS REAL) > 0 AND CAST(quote_wei AS REAL) > 0
    ),
    opens AS (
      SELECT token, px FROM firsts WHERE rn = 1
      UNION ALL
      SELECT token, first_price px FROM curve_summary
      WHERE first_price > 0 AND token NOT IN (SELECT token FROM firsts WHERE rn = 1)
    )
    SELECT p.token_is_c1, p.dec0, p.dec1, p.init_sqrt, o.px first_px
    FROM pools p JOIN opens o ON o.token = p.token`).all() as
    Array<PoolRow & { first_px: number }>;

  const ratios: number[] = [];
  for (const r of rows) {
    const open = r.first_px * (1e18 / 10 ** (r.token_is_c1 ? r.dec0 : r.dec1));
    const grad = quotePerToken(r.init_sqrt, r);
    if (open > 0 && grad > 0 && Number.isFinite(grad / open)) ratios.push(grad / open);
  }
  ratios.sort((a, b) => a - b);
  const v = ratios.length >= 30 ? ratios[Math.floor(ratios.length / 2)] : null;
  gradMult = { at: Date.now(), v };
  return v;
}
