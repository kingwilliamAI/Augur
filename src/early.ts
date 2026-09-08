import { BLOCKS_PER_SECOND } from "./curve.ts";
import { quotePerToken } from "./pool.ts";
import type { DB } from "./db.ts";

/**
 * What the first seconds of trading say, which the model has never been allowed to see.
 *
 * Every feature the scanner uses today is knowable the instant the launch transaction lands: who
 * made it, what they declared, what they bought themselves, what they have launched before. That is
 * the right cut for a board that wants to speak at T+0, and it leaves an entire source of evidence
 * on the floor — the market's own first reaction. Whether four wallets or forty turned up in the
 * opening seconds, whether the creator sold into them, whether one address is buying its own token
 * back and forth to draw a chart: none of that is in the score.
 *
 * The cost of using it is that a claim made at T+30s is a different product from one made at T+0.
 * Half of graduations happen inside two minutes, so thirty seconds is still early enough to act on —
 * but it is thirty seconds of the two minutes spent, and a model built on this must be logged and
 * graded as its own thing rather than blended into a record it did not earn.
 *
 * Everything here is computed from trades strictly inside the window. A feature that peeks one block
 * past it is not a feature, it is the answer.
 */

export type Early = {
  token: string;
  /** Trades of both sides inside the window. */
  trades: number;
  buys: number;
  sells: number;
  /** Distinct wallets that received tokens from a buy. The crowd, as far as the chain can see it. */
  buyers: number;
  /** Distinct wallets that sold. */
  sellers: number;
  /** Quote paid in, summed over buys, in the launch's own quote units. */
  buyVolume: number;
  /** Quote taken out, summed over sells. */
  sellVolume: number;
  /** Last price in the window over the first price in it. */
  priceMove: number;
  /** The largest single buy as a share of all buying. One wallet at 0.9 is not a crowd. */
  topBuyShare: number;
  /** Buys per distinct buyer. Above 1 means wallets coming back — or one wallet churning. */
  buysPerBuyer: number;
  /** Did the wallet that sent the launch transaction sell inside the window? */
  creatorSold: 0 | 1;
  /** Wallets that paid the 99% opening tax to get in ahead of everyone. */
  snipers: number;
  /** Blocks from launch to the first buy by someone other than the creator, or the window if none. */
  blocksToCrowd: number;
  /** Selling as a share of buying. Above 1 is a window that handed back more than it took. */
  sellPressure: number;
};

export type Outcome = {
  token: string;
  ts: number;
  graduated: 0 | 1;
  /** The effective peak as a multiple of the launch price: the pool's if it graduated, else the curve's. */
  peak: number;
  /**
   * The peak *after* the observation window, as a multiple of the price at the end of it.
   *
   * This is the target, and the difference between it and `peak` is the difference between a finding
   * and a tautology. A pattern searched against `peak` immediately discovers that a launch already up
   * 3.8x in its first thirty seconds tends to reach 5x — which is true, circular, and worthless: the
   * peak is measured over a period that contains the window the pattern is reading. Every candidate
   * in the first run of this search was a restatement of that one fact.
   *
   * Measured from the last price inside the window, forward only, it is instead the multiple a buyer
   * at T+window would actually have been able to capture. 1.0 means the token never traded higher
   * again.
   */
  peakAfter: number;
};

/** The window, in blocks. Chain runs at ~9.91 blocks a second. */
export const windowBlocks = (seconds: number): number => Math.round(seconds * BLOCKS_PER_SECOND);

/**
 * Early features for every launch whose curve has been read.
 *
 * One ordered scan of the trades rather than a query per token: the whole point of this file is to
 * be cheap enough to recompute at several window lengths in one run, because how much the first
 * seconds are worth is itself one of the questions.
 */
export function earlyFeatures(db: DB, seconds: number, tokens?: Set<string>): Map<string, Early> {
  const width = windowBlocks(seconds);

  const launches = new Map<string, { block: number; creator: string }>();
  for (
    const r of db.prepare(
      "SELECT token, block, COALESCE(launch_sender, deployer) creator FROM launches",
    ).all() as Array<{ token: string; block: number; creator: string }>
  ) {
    if (tokens && !tokens.has(r.token)) continue;
    launches.set(r.token, { block: r.block, creator: (r.creator ?? "").toLowerCase() });
  }

  const snipers = new Map<string, Set<string>>();
  for (
    const r of db.prepare("SELECT token, payer FROM snipe_tax").all() as
      Array<{ token: string; payer: string }>
  ) {
    if (!launches.has(r.token)) continue;
    let s = snipers.get(r.token);
    if (!s) snipers.set(r.token, (s = new Set()));
    s.add(r.payer);
  }

  const out = new Map<string, Early>();
  type Acc = {
    e: Early; first: number; last: number; buyers: Set<string>; sellers: Set<string>;
    topBuy: number; creator: string; launchBlock: number; crowdAt: number | null;
  };
  let acc: Acc | null = null;

  const flush = (): void => {
    if (!acc) return;
    const e = acc.e;
    e.buyers = acc.buyers.size;
    e.sellers = acc.sellers.size;
    e.priceMove = acc.first > 0 ? acc.last / acc.first : 1;
    e.topBuyShare = e.buyVolume > 0 ? acc.topBuy / e.buyVolume : 0;
    e.buysPerBuyer = acc.buyers.size ? e.buys / acc.buyers.size : 0;
    e.sellPressure = e.buyVolume > 0 ? e.sellVolume / e.buyVolume : 0;
    e.snipers = snipers.get(e.token)?.size ?? 0;
    e.blocksToCrowd = acc.crowdAt ?? width;
    out.set(e.token, e);
    acc = null;
  };

  const rows = db.prepare(
    `SELECT token, side, actor, recipient, quote_wei, token_amt, block
     FROM curve_trades ORDER BY token, block, log_index`,
  ).iterate() as Iterable<{
    token: string; side: string; actor: string; recipient: string;
    quote_wei: string; token_amt: string; block: number;
  }>;

  for (const r of rows) {
    const l = launches.get(r.token);
    if (!l) continue;
    if (!acc || acc.e.token !== r.token) {
      flush();
      acc = {
        e: {
          token: r.token, trades: 0, buys: 0, sells: 0, buyers: 0, sellers: 0, buyVolume: 0,
          sellVolume: 0, priceMove: 1, topBuyShare: 0, buysPerBuyer: 0, creatorSold: 0,
          snipers: 0, blocksToCrowd: width, sellPressure: 0,
        },
        first: 0, last: 0, buyers: new Set(), sellers: new Set(),
        topBuy: 0, creator: l.creator, launchBlock: l.block, crowdAt: null,
      };
    }
    // Past the window is the future. Trades keep arriving in the scan because it is ordered by token
    // and block, so this skips rather than breaks.
    if (r.block > acc.launchBlock + width) continue;

    const amt = Number(r.token_amt);
    const quote = Number(r.quote_wei);
    if (!(amt > 0) || !(quote > 0)) continue;
    const price = quote / amt;
    if (!Number.isFinite(price) || price <= 0) continue;

    if (acc.first === 0) acc.first = price;
    acc.last = price;
    acc.e.trades++;

    if (r.side === "sell") {
      acc.e.sells++;
      acc.e.sellVolume += quote;
      acc.sellers.add(r.actor);
      if (r.actor === acc.creator) acc.e.creatorSold = 1;
    } else {
      acc.e.buys++;
      acc.e.buyVolume += quote;
      acc.buyers.add(r.recipient);
      if (quote > acc.topBuy) acc.topBuy = quote;
      if (r.recipient !== acc.creator && acc.crowdAt === null) acc.crowdAt = r.block - acc.launchBlock;
    }
  }
  flush();
  return out;
}

/**
 * What each launch actually did, on both targets at once.
 *
 * The peak follows `model/ath.ts` exactly — the pool's high where a token graduated, the curve's
 * where it did not, whichever is larger — because a pattern that improves the peak model has to be
 * measured against the number that model is fitted on, not a second definition that happens to be
 * easier to compute here.
 */
export function outcomes(db: DB, seconds: number, minTrades = 4): Map<string, Outcome> {
  const width = windowBlocks(seconds);

  const launchBlock = new Map<string, number>();
  const launchTs = new Map<string, number>();
  for (
    const r of db.prepare("SELECT token, block, ts FROM launches").all() as
      Array<{ token: string; block: number; ts: number }>
  ) {
    launchBlock.set(r.token, r.block);
    launchTs.set(r.token, r.ts);
  }

  type Acc = {
    first: number; peak: number; count: number;
    /** Last price seen inside the window: what a buyer at T+window pays. */
    atWindow: number;
    /** Highest price strictly after the window: what they could have sold into. */
    peakAfter: number;
  };
  const accs = new Map<string, Acc>();

  let token = "";
  let acc: Acc | null = null;
  const start = (t: string): Acc => {
    const a: Acc = { first: 0, peak: 0, count: 0, atWindow: 0, peakAfter: 0 };
    accs.set(t, a);
    return a;
  };

  for (
    const r of db.prepare("SELECT token, quote_wei, token_amt, block FROM curve_trades ORDER BY token, block, log_index")
      .iterate() as Iterable<{ token: string; quote_wei: string; token_amt: string; block: number }>
  ) {
    if (r.token !== token) { token = r.token; acc = start(token); }
    if (!acc) continue;
    const lb = launchBlock.get(r.token);
    if (lb === undefined) continue;
    const amt = Number(r.token_amt);
    if (!(amt > 0)) continue;
    const p = Number(r.quote_wei) / amt;
    if (!(p > 0) || !Number.isFinite(p)) continue;

    if (acc.first === 0) acc.first = p;
    if (p > acc.peak) acc.peak = p;
    acc.count++;
    if (r.block <= lb + width) acc.atWindow = p;
    else if (p > acc.peakAfter) acc.peakAfter = p;
  }

  const grads = new Set(
    (db.prepare("SELECT token FROM graduations").all() as Array<{ token: string }>).map((g) => g.token),
  );

  // The pool answers for anything that graduated, on both targets. Its peak lands after the window
  // by construction — graduation takes far longer than thirty seconds — so it is a candidate for
  // `peakAfter` as well as for the lifetime peak.
  const poolPeak = new Map<string, number>();
  for (
    const r of db.prepare(`
      SELECT p.token, p.token_is_c1, p.dec0, p.dec1, p.init_sqrt, k.min_sqrt, k.max_sqrt
      FROM pools p JOIN pool_peaks k ON k.pool_id = p.pool_id`).all() as Array<{
        token: string; token_is_c1: number; dec0: number; dec1: number;
        init_sqrt: string; min_sqrt: string; max_sqrt: string;
      }>
  ) {
    const a = accs.get(r.token);
    if (!a || !(a.first > 0)) continue;
    // Pool prices are whole quote per whole token; curve prices are raw over raw. Bring the pool
    // down into the curve's units so a ratio between them is a price move, not a decimal gap.
    const tokenDec = r.token_is_c1 ? r.dec1 : r.dec0;
    const quoteDec = r.token_is_c1 ? r.dec0 : r.dec1;
    const toRaw = 10 ** (quoteDec - tokenDec);
    const best = Math.max(
      quotePerToken(r.token_is_c1 ? r.min_sqrt : r.max_sqrt, r),
      quotePerToken(r.init_sqrt, r),
    ) * toRaw;
    if (best > 0 && Number.isFinite(best)) poolPeak.set(r.token, best);
  }

  const out = new Map<string, Outcome>();
  for (const [t, a] of accs) {
    if (a.count < minTrades || !(a.first > 0) || !(a.peak > 0)) continue;
    const ts = launchTs.get(t);
    if (ts === undefined) continue;
    const pool = poolPeak.get(t) ?? 0;
    const peak = Math.max(a.peak, pool) / a.first;
    // A launch whose curve never printed after the window has no forward peak to measure, and
    // pretending it stayed flat would fill the sample with manufactured 1.0s. Those are dropped by
    // the caller through `peakAfter === 0`.
    const after = Math.max(a.peakAfter, pool);
    const peakAfter = a.atWindow > 0 && after > 0 ? Math.max(after / a.atWindow, 1) : 0;
    out.set(t, { token: t, ts, graduated: grads.has(t) ? 1 : 0, peak, peakAfter });
  }
  return out;
}

/** The numeric fields a pattern may be built from, named for printing. */
export const EARLY_FIELDS: Array<keyof Early> = [
  "trades", "buys", "sells", "buyers", "sellers", "buyVolume", "sellVolume", "priceMove",
  "topBuyShare", "buysPerBuyer", "creatorSold", "snipers", "blocksToCrowd", "sellPressure",
];
