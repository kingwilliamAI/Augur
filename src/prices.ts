import { existsSync, readFileSync } from "node:fs";
import { curvePrices } from "./curve.ts";
import type { DB } from "./db.ts";

/**
 * Dollar prices for the assets launches are quoted against.
 *
 * This is the one number in the project that cannot come from the chain. Half of launches are quoted
 * against a tokenised stock, and a share price lives at an exchange, not in a log. The tool will not
 * fetch it: the promise is that nothing leaves the machine, and a background call to a price API
 * would quietly break that for a cosmetic figure.
 *
 * So prices are a file you own. The snapshot below is what shipped; `data/prices.json` overrides it,
 * and the card says how old the figures are so a market cap is read as the estimate it is.
 *
 * The graduation threshold is *not* a substitute, though it looks like one. pons sets it near a
 * fixed dollar amount per asset, so threshold × price should be constant — measured across the
 * sixteen assets covering 90% of launches it lands between $6,606 and $10,682, median $8,395, a
 * spread of ±23%. Right in direction, far too loose to price anything with.
 */
export type PriceBook = { asOf: string; note: string; usd: Record<string, number> };

const SHIPPED: PriceBook = {
  asOf: "2026-09-06",
  note: "snapshot supplied by hand; edit data/prices.json to refresh",
  usd: {
    ETH: 2520, USDG: 1.0, NVDA: 230.36, SPCX: 147.95, SPY: 770.19, DJT: 9.03,
    GME: 19.16, QQQ: 718.96, RDDT: 155.99, GLD: 406.77, TSLA: 347, AAPL: 319.97,
    cbBTC: 79850, MSFT: 499.7, GOOGL: 338.46, HIMS: 27.81,
  },
};

let cache: { at: number; book: PriceBook } | null = null;

export function priceBook(path = "./data/prices.json"): PriceBook {
  if (cache && Date.now() - cache.at < 30_000) return cache.book;
  let book = SHIPPED;
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PriceBook>;
      if (raw && typeof raw.usd === "object" && raw.usd) {
        book = { asOf: raw.asOf ?? "unknown", note: raw.note ?? "from data/prices.json", usd: { ...SHIPPED.usd, ...raw.usd } };
      }
    } catch {
      // A malformed file falls back to the shipped snapshot rather than pricing nothing.
    }
  }
  cache = { at: Date.now(), book };
  return book;
}

/** Dollars per whole unit of a quote asset, or null when we have no price for it. */
export function usdOf(symbol: string | null | undefined): number | null {
  if (!symbol) return null;
  const { usd } = priceBook();
  return usd[symbol] ?? null;
}

/** Every launch mints the same fixed supply, so a market cap is price times this. */
export const SUPPLY = 1e9;

/**
 * Market cap in dollars from a price expressed in quote units per whole token.
 *
 * Returns null rather than zero when the quote asset has no price: a card that says "—" is honest,
 * and one that says "$0" is not.
 */
export function marketCapUsd(pricePerToken: number, quoteSymbol: string | null): number | null {
  const usd = usdOf(quoteSymbol);
  if (usd === null || !Number.isFinite(pricePerToken)) return null;
  return pricePerToken * SUPPLY * usd;
}

export function formatUsd(v: number | null): string {
  if (v === null) return "—";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  // A decimal below $100K, because that is where these numbers live and rounding to whole thousands
  // made distinct values print identically: a $6,600 estimate and a $7,400 upper bound both read
  // "$7K", so a range appeared to have its own midpoint sitting on its edge.
  if (v >= 1e5) return `$${Math.round(v / 1e3)}K`;
  // A trailing ".0" is noise, so $47.0K prints as $47K while $6.8K keeps the digit that matters.
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return `$${Math.round(v)}`;
}

/**
 * Launch and peak market cap for one token, straight from its curve trades.
 *
 * Prices come from the trades themselves — buys and sells alike, each recording what was paid and
 * what came back — scaled by both sides' decimals so a 6-decimal stablecoin and an 18-decimal stock
 * give comparable figures.
 */
export function capsFor(db: DB, token: string, quoteSymbol: string | null, quoteDecimals: number): {
  launchUsd: number | null; peakUsd: number | null; peakMultiple: number | null;
} {
  const p = curvePrices(db, token);
  if (p === null) return { launchUsd: null, peakUsd: null, peakMultiple: null };

  // Raw prices are quote units per token unit; this lifts them to whole quote per whole token.
  const scale = 1e18 / 10 ** quoteDecimals;
  const first = p.first * scale;
  const peak = p.peak * scale;
  return {
    launchUsd: marketCapUsd(first, quoteSymbol),
    peakUsd: marketCapUsd(peak, quoteSymbol),
    peakMultiple: peak / first,
  };
}

/**
 * What a launch is worth the moment it opens, per quote asset.
 *
 * The curve starts at a price the protocol fixes, so this is very nearly a constant: measured across
 * 2,512 read curves the starting cap sits at roughly $4K with a p90/p10 spread of 1.33, and within a
 * single quote asset it is tighter still. That is what lets a *fresh* launch — one with no trades yet
 * — have its predicted multiple expressed in dollars at all. Without it the model could only ever say
 * "x3", never "about $12K".
 *
 * Measured rather than assumed, and null when too few curves have been read for that asset to say.
 */
const startCache = new Map<string, number | null>();

export function startingCapUsd(db: DB, quoteSymbol: string | null, quoteDecimals: number): number | null {
  if (!quoteSymbol) return null;
  const hit = startCache.get(quoteSymbol);
  if (hit !== undefined) return hit;

  // Opening prices come from whichever store still holds them: the first trade of a curve that
  // still has its rows, or the first price kept by a curve that has been compacted. Reading only
  // the trades would make this figure drift as older curves are folded away.
  const asQuote = `CASE WHEN l.pair_token = '0x0000000000000000000000000000000000000000'
                        THEN 'ETH' ELSE coalesce(q.symbol,'?') END = ?`;
  const rows = db.prepare(`
    SELECT CAST(t.quote_wei AS REAL) / CAST(t.token_amt AS REAL) px
    FROM curve_trades t
    JOIN launches l USING(token)
    LEFT JOIN quote_assets q ON q.address = l.pair_token
    WHERE t.side = 'buy' AND CAST(t.token_amt AS REAL) > 0 AND ${asQuote}
      AND t.rowid IN (SELECT min(rowid) FROM curve_trades WHERE side='buy' GROUP BY token)
    UNION ALL
    SELECT s.first_price px
    FROM curve_summary s
    JOIN launches l USING(token)
    LEFT JOIN quote_assets q ON q.address = l.pair_token
    WHERE ${asQuote}`).all(quoteSymbol, quoteSymbol) as Array<{ px: number }>;

  const caps: number[] = [];
  for (const r of rows) {
    if (!(r.px > 0) || !Number.isFinite(r.px)) continue;
    // Raw quote units per token unit, lifted to whole units on both sides.
    const cap = marketCapUsd(r.px * (1e18 / 10 ** quoteDecimals), quoteSymbol);
    if (cap !== null && Number.isFinite(cap)) caps.push(cap);
  }
  caps.sort((a, b) => a - b);
  const median = caps.length >= 5 ? caps[Math.floor(caps.length / 2)] : null;
  startCache.set(quoteSymbol, median);
  return median;
}
