import { decodeEventLog, type Log } from "viem";
import { curveAbi, TOPIC } from "./abi.ts";
import { logsClient, withRetry } from "./chain.ts";
import { toEth, type DB } from "./db.ts";

type RawLog = Log & { topics: [`0x${string}`, ...`0x${string}`[]]; data: `0x${string}` };
const num = (h: unknown): number => Number(BigInt(h as string));

/** ~0.1009 s per block, so the 3-second opening window is about 30 blocks. */
export const BLOCKS_PER_SECOND = 9.91;
export const SNIPE_WINDOW_BLOCKS = 30;

/**
 * Pulls one token's trading history off its curve.
 *
 * Curve events live on each curve's own address, and there are tens of thousands of curves a day, so
 * this is deliberately per-token and on demand rather than a chain-wide stream: opening a card is
 * one `eth_getLogs`, which is cheap, while indexing every curve continuously is not.
 */
export async function indexCurve(
  db: DB, token: string, curve: string, fromBlock: number, toBlock: number,
): Promise<{ buys: number; sells: number; snipes: number }> {
  const logs = (await withRetry(() =>
    logsClient.request({
      method: "eth_getLogs",
      params: [{ address: curve, fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}` }],
    } as never),
  )) as RawLog[];

  const insTrade = db.prepare(`
    INSERT INTO curve_trades (token, tx, log_index, side, actor, recipient,
      quote_wei, quote_eth, token_amt, fee_wei, tax_wei, tax_eth, block, ts)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tx, log_index) DO NOTHING`);
  const insSnipe = db.prepare(`
    INSERT INTO snipe_tax (token, tx, log_index, payer, amount_wei, block)
    VALUES (?,?,?,?,?,?) ON CONFLICT(tx, log_index) DO NOTHING`);

  const out = { buys: 0, sells: 0, snipes: 0 };
  db.exec("BEGIN");
  try {
    for (const l of logs) {
      const t0 = l.topics[0];
      if (t0 !== TOPIC.curveBuy && t0 !== TOPIC.curveSell && t0 !== TOPIC.snipeTaxCharged) continue;
      let ev: ReturnType<typeof decodeEventLog>;
      try {
        ev = decodeEventLog({ abi: curveAbi, topics: l.topics, data: l.data });
      } catch {
        continue;
      }
      const a = ev.args as Record<string, unknown>;
      const block = num(l.blockNumber);
      const tx = l.transactionHash as string;
      const li = num(l.logIndex);

      if (ev.eventName === "SnipeTaxCharged") {
        insSnipe.run(token, tx, li, String(a.payer).toLowerCase(), (a.amount as bigint).toString(), block);
        out.snipes++;
        continue;
      }
      const isBuy = ev.eventName === "CurveBuy";
      // A buy spends quote for tokens; a sell does the reverse. Both are stored with the quote leg
      // in `quote_wei` so "money in" and "money out" are one column.
      const quote = (isBuy ? a.quoteIn : a.quoteOut) as bigint;
      const tokens = (isBuy ? a.tokensOut : a.tokensIn) as bigint;
      const actor = String(isBuy ? a.buyer : a.seller).toLowerCase();
      insTrade.run(
        token, tx, li, isBuy ? "buy" : "sell", actor, String(a.recipient).toLowerCase(),
        quote.toString(), toEth(quote), tokens.toString(),
        (a.fee as bigint).toString(), (a.tax as bigint).toString(), toEth(a.tax as bigint), block, 0,
      );
      if (isBuy) out.buys++;
      else out.sells++;
    }
    db.prepare(`INSERT INTO curve_indexed (token, to_block, trades, indexed_at) VALUES (?,?,?,?)
      ON CONFLICT(token) DO UPDATE SET to_block=excluded.to_block, trades=curve_indexed.trades+excluded.trades, indexed_at=excluded.indexed_at`)
      .run(token, toBlock, out.buys + out.sells, Math.floor(Date.now() / 1000));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return out;
}

/**
 * The highest price the curve ever traded at, as a multiple of its first trade.
 *
 * Deliberately a ratio, not a market cap in dollars. Every trade carries what was paid and what came
 * back, so a price falls straight out of the log — but turning that into "$1.4M" needs the quote
 * asset's price in dollars, and half of launches are quoted in a tokenised stock. That number can
 * only come from an off-chain feed, which this tool does not have and does not want. A ratio needs
 * neither an oracle nor the asset's decimals: both sides scale identically, so a USDG launch whose
 * prices read 4.8e-18 still reports a clean x8.30.
 *
 * It is what happened, not a forecast. Null only when the curve has no trades at all — a launch
 * that traded exactly once peaked at the price it opened at, which is x1.00 and worth saying.
 */
export function peakMultiple(db: DB, token: string): number | null {
  const p = curvePrices(db, token);
  return p === null ? null : p.peak / p.first;
}

/**
 * The three prices that outlive a curve's individual trades.
 *
 * Raw rows answer while they exist, and the stored summary answers once they have been compacted
 * away. Everything downstream asks in these terms rather than for the trades themselves, so a
 * compacted curve keeps reporting the same peak, the same opening and the same last price it did
 * the day it was read.
 *
 * Raw units throughout, quote per token, exactly as the trades were: the factor between raw and
 * whole units is constant within a launch, so ratios taken here mean what they always meant.
 */
export type CurvePrices = { first: number; peak: number; last: number; trades: number };

export function curvePrices(db: DB, token: string): CurvePrices | null {
  const prices = tradePrices(db, token);
  if (prices.length) {
    return { first: prices[0], peak: Math.max(...prices), last: prices[prices.length - 1], trades: prices.length };
  }
  const s = db.prepare(
    "SELECT first_price, peak_price, last_price, trades FROM curve_summary WHERE token = ?",
  ).get(token) as { first_price: number; peak_price: number; last_price: number; trades: number } | undefined;
  return s ? { first: s.first_price, peak: s.peak_price, last: s.last_price, trades: s.trades } : null;
}

/**
 * Every price the curve traded at, in raw quote units per raw token unit, in order.
 *
 * Both sides count. A sell carries a price exactly as a buy does — quote out over tokens in — and
 * reading only buys threw away half the price path. That mattered most for the launches a creator
 * bought and dumped themselves: one buy, one sell, and a peak that came back empty because a second
 * price was demanded and the sell was not allowed to be one. Those launches are precisely the ones a
 * reader wants counted, because a serial launcher's record is mostly made of them.
 *
 * The tax does not need netting out. It is charged against the token side, not the quote side:
 * measured over 1,178 taxed opening trades it is 1.3% of `quote_wei` at the median and 11.2% at the
 * worst, and netting it moves the implied price from 0.92x to 0.90x of the first post-window trade.
 * An opening buy is not the 100x outlier the 99% headline rate would suggest.
 *
 * Raw units on purpose: the factor between raw and whole units is constant within a launch, so it
 * cancels in any ratio and multiplies out cleanly when a caller wants dollars.
 */
export function tradePrices(db: DB, token: string): number[] {
  const rows = db.prepare(
    "SELECT quote_wei, token_amt FROM curve_trades WHERE token = ? ORDER BY block, log_index",
  ).all(token) as Array<{ quote_wei: string; token_amt: string }>;

  const prices: number[] = [];
  for (const r of rows) {
    const tokens = Number(r.token_amt);
    if (!(tokens > 0)) continue;
    const p = Number(r.quote_wei) / tokens;
    if (p > 0 && Number.isFinite(p)) prices.push(p);
  }
  return prices;
}

/**
 * Folds one curve down to what is read after the day it launched, ready for its trades to go.
 *
 * Computed from the rows while they are still there and stored whole, so nothing is approximated:
 * what a compacted card shows is exactly what it showed before, minus the per-transaction links.
 * That is the deliberate loss. A launch nobody has opened in a week is read for its shape, not for
 * the hash of its fourteenth buy.
 *
 * Returns false for a curve with nothing to fold, which is left alone: an unread curve and an empty
 * one are both better represented by no summary than by a summary of nothing.
 */
export function summariseCurve(db: DB, token: string, launchBlock: number): boolean {
  const p = curvePrices(db, token);
  if (p === null || !p.trades) return false;
  const stats = curveStats(db, token, launchBlock);
  if (!stats.indexed) return false;

  // What the creator took of their own supply. It is a per-trade fact, so it has to be read here,
  // while the trades are still on disk, or it goes with them.
  const own = db.prepare(`
    SELECT sum(CAST(t.token_amt AS REAL)) amt FROM curve_trades t
    JOIN launches l USING(token)
    WHERE t.token = ? AND t.side = 'buy' AND t.block = l.block AND t.recipient = l.deployer`).get(token) as
    | { amt: number | null } | undefined;

  db.prepare(`
    INSERT INTO curve_summary (token, first_price, peak_price, last_price, trades, buys, sells, stats_json, compacted_at, self_buy_tokens)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(token) DO UPDATE SET
      first_price = excluded.first_price, peak_price = excluded.peak_price, last_price = excluded.last_price,
      trades = excluded.trades, buys = excluded.buys, sells = excluded.sells,
      stats_json = excluded.stats_json, compacted_at = excluded.compacted_at,
      self_buy_tokens = excluded.self_buy_tokens`).run(
    token, p.first, p.peak, p.last, stats.trades, stats.buys, stats.sells,
    JSON.stringify(stats), Math.floor(Date.now() / 1000), own?.amt ?? null,
  );
  return true;
}

export type Sniper = { address: string; taxWei: string; boughtWei: string; blocksAfterLaunch: number; wasExempt: boolean };
export type Position = {
  address: string; boughtWei: string; soldWei: string; netTokens: string;
  entryPrice: number | null; multiple: number | null; realisedPnlEth: number;
};

export type CurveStats = {
  indexed: boolean;
  trades: number; buys: number; sells: number;
  buyersFirstMinute: number;
  buyersTotal: number;
  coBuyersInLaunchTx: Array<{ address: string; quoteWei: string }>;
  snipers: Sniper[];
  snipeTaxTotalWei: string;
  lastPrice: number | null;
  /** Highest traded price as a multiple of the first trade. Observed, never predicted. */
  peakMultiple: number | null;
  positions: Position[];
};

/**
 * Everything derived from one token's curve trades.
 *
 * Prices come from the trades themselves — each buy carries what was paid and what came back — so no
 * extra call is needed and the number is exactly what someone actually transacted at, not a quote.
 */
export function curveStats(db: DB, token: string, launchBlock: number): CurveStats {
  const state = db.prepare("SELECT to_block, trades FROM curve_indexed WHERE token = ?").get(token) as
    | { to_block: number; trades: number } | undefined;
  if (!state) {
    return { indexed: false, trades: 0, buys: 0, sells: 0, buyersFirstMinute: 0, buyersTotal: 0,
      coBuyersInLaunchTx: [], snipers: [], snipeTaxTotalWei: "0", lastPrice: null, peakMultiple: null, positions: [] };
  }

  const rows = db.prepare(
    "SELECT side, actor, recipient, quote_wei, token_amt, block, tx FROM curve_trades WHERE token = ? ORDER BY block, log_index",
  ).all(token) as Array<{ side: string; actor: string; recipient: string; quote_wei: string; token_amt: string; block: number; tx: string }>;

  // A curve that was read and then compacted has no rows and a summary instead. The summary is what
  // this function returned on the day the rows were still there, so it is served verbatim rather
  // than recomputed from something thinner.
  if (!rows.length) {
    const kept = db.prepare("SELECT stats_json FROM curve_summary WHERE token = ?").get(token) as
      | { stats_json: string } | undefined;
    if (kept) {
      try {
        return JSON.parse(kept.stats_json) as CurveStats;
      } catch {
        // A summary we cannot parse is worse than none; fall through and report an empty curve.
      }
    }
  }

  const buys = rows.filter((r) => r.side === "buy");
  const sells = rows.filter((r) => r.side === "sell");
  const minuteCutoff = launchBlock + Math.round(60 * BLOCKS_PER_SECOND);

  const exempt = new Set(
    (db.prepare("SELECT address FROM exemptions WHERE token = ?").all(token) as Array<{ address: string }>).map((e) => e.address),
  );

  const snipeRows = db.prepare(
    "SELECT payer, amount_wei, block FROM snipe_tax WHERE token = ? ORDER BY block",
  ).all(token) as Array<{ payer: string; amount_wei: string; block: number }>;

  const boughtBy = new Map<string, bigint>();
  for (const b of buys) boughtBy.set(b.recipient, (boughtBy.get(b.recipient) ?? 0n) + BigInt(b.quote_wei));

  const snipers: Sniper[] = snipeRows.map((s) => ({
    address: s.payer,
    taxWei: s.amount_wei,
    boughtWei: (boughtBy.get(s.payer) ?? 0n).toString(),
    blocksAfterLaunch: s.block - launchBlock,
    wasExempt: exempt.has(s.payer),
  }));

  // Position per wallet: what went in, what came out, and where they stand now.
  const agg = new Map<string, { in: bigint; out: bigint; tokIn: bigint; tokOut: bigint }>();
  for (const r of rows) {
    const key = r.recipient;
    const a = agg.get(key) ?? { in: 0n, out: 0n, tokIn: 0n, tokOut: 0n };
    if (r.side === "buy") { a.in += BigInt(r.quote_wei); a.tokIn += BigInt(r.token_amt); }
    else { a.out += BigInt(r.quote_wei); a.tokOut += BigInt(r.token_amt); }
    agg.set(key, a);
  }

  // Last traded price in quote per token, from the most recent trade of either side.
  const last = rows[rows.length - 1];
  const lastPrice = last && BigInt(last.token_amt) > 0n
    ? Number(BigInt(last.quote_wei)) / Number(BigInt(last.token_amt))
    : null;

  const positions: Position[] = [...agg.entries()].map(([address, a]) => {
    const netTokens = a.tokIn - a.tokOut;
    const entryPrice = a.tokIn > 0n ? Number(a.in) / Number(a.tokIn) : null;
    return {
      address,
      boughtWei: a.in.toString(),
      soldWei: a.out.toString(),
      netTokens: netTokens.toString(),
      entryPrice,
      multiple: entryPrice && lastPrice ? lastPrice / entryPrice : null,
      realisedPnlEth: toEth(a.out - a.in),
    };
  }).sort((x, y) => Number(BigInt(y.boughtWei) - BigInt(x.boughtWei)));

  return {
    indexed: true,
    trades: rows.length,
    buys: buys.length,
    sells: sells.length,
    buyersFirstMinute: new Set(buys.filter((b) => b.block <= minuteCutoff).map((b) => b.recipient)).size,
    buyersTotal: new Set(buys.map((b) => b.recipient)).size,
    coBuyersInLaunchTx: buys.filter((b) => b.block === launchBlock)
      .map((b) => ({ address: b.recipient, quoteWei: b.quote_wei })),
    snipers,
    snipeTaxTotalWei: snipeRows.reduce((s, r) => s + BigInt(r.amount_wei), 0n).toString(),
    lastPrice,
    peakMultiple: peakMultiple(db, token),
    positions,
  };
}
