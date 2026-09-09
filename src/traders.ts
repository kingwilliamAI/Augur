import { CFG } from "./config.ts";
import type { DB } from "./db.ts";
import { usdOf } from "./prices.ts";
import { quoteFromCache } from "./quote.ts";

/**
 * What makes a wallet worth following into a trade, and what makes that claim hard to manufacture.
 *
 * This is the part of the feature that is a decision rather than an implementation, so it is written
 * down rather than buried.
 *
 * **Wash trading is not the threat here.** A bonding curve has no counterparty to collude with: a
 * wallet buys from the curve and sells to the curve, paying about 1.6% each way plus whatever the
 * creator's tax is, and a 99% tax for the first three seconds. Trading with yourself on a curve is a
 * way to lose money slowly, not to manufacture a record.
 *
 * **Access is the threat.** Two ways of being early have nothing to do with judgement:
 *
 * - creating the token, and buying it before anybody else can;
 * - being on the creator's exemption list, which waives the opening tax that stops everyone else
 *   from buying in the first three seconds.
 *
 * Either one lets a wallet post a spectacular return on a token whose price it was handed rather
 * than found. Both are recorded on chain — one in `launches`, one in `exemptions` — so both are
 * excluded here, per token rather than per wallet: a creator's own launches do not count towards
 * their record, and their trades in somebody else's token do.
 *
 * **What is left is still not proof.** A wallet can be lucky, and thirty tokens is not a large
 * sample. So the ranking demands a minimum number of closed positions in unrelated tokens and
 * reports the count beside the number, and the bot says "has done this before" rather than "is
 * good". Nothing here is a recommendation to buy anything.
 */

export type Trade = {
  wallet: string;
  token: string;
  side: "buy" | "sell";
  /** Quote asset moved, in whole units of that asset. */
  quote: number;
  /** Token units moved, in whole units. */
  tokens: number;
  ts: number;
};

/**
 * Folds one trade into a wallet's position, creating it if this is their first.
 *
 * Insider status is decided once, when the position opens, from facts that cannot change afterwards:
 * whether this wallet launched the token, and whether the creator waived the opening tax for them.
 */
export function applyTrade(db: DB, t: Trade): void {
  const wallet = t.wallet.toLowerCase();
  const token = t.token.toLowerCase();

  const exists = db.prepare("SELECT 1 x FROM trader_positions WHERE wallet = ? AND token = ?")
    .get(wallet, token);
  if (!exists) {
    const created = db.prepare(`SELECT 1 x FROM launches
      WHERE token = ? AND (launch_sender = ? OR deployer = ?) LIMIT 1`).get(token, wallet, wallet);
    const waived = db.prepare("SELECT 1 x FROM exemptions WHERE token = ? AND address = ? LIMIT 1")
      .get(token, wallet);
    db.prepare(`INSERT INTO trader_positions (wallet, token, first_ts, last_ts, insider)
      VALUES (?,?,?,?,?)`).run(wallet, token, t.ts, t.ts, created || waived ? 1 : 0);
  }

  db.prepare(`UPDATE trader_positions SET
      quote_in   = quote_in   + ?,
      quote_out  = quote_out  + ?,
      tokens_in  = tokens_in  + ?,
      tokens_out = tokens_out + ?,
      buys       = buys  + ?,
      sells      = sells + ?,
      last_ts    = max(last_ts, ?)
    WHERE wallet = ? AND token = ?`)
    .run(
      t.side === "buy" ? t.quote : 0,
      t.side === "sell" ? t.quote : 0,
      t.side === "buy" ? t.tokens : 0,
      t.side === "sell" ? t.tokens : 0,
      t.side === "buy" ? 1 : 0,
      t.side === "sell" ? 1 : 0,
      t.ts, wallet, token,
    );
}

export type TraderRecord = {
  wallet: string;
  /** Closed positions in tokens this wallet neither created nor was waived the opening tax on. */
  closed: number;
  wins: number;
  /** Realised profit in dollars, summed across closed positions. */
  realisedUsd: number;
  /** The share of closed positions that returned more than they cost. */
  winRate: number;
  /** The best single closed position, as a multiple of what went in. */
  bestMultiple: number;
  lastTs: number;
};

/**
 * A position is closed when the wallet has sold essentially all of what it bought.
 *
 * Ninety-five per cent rather than all of it, because a curve leaves dust: selling the exact balance
 * requires reading it, and a trader who has taken 99% of their position off the table has closed it
 * in every sense that matters to somebody reading their record.
 */
const CLOSED_AT = 0.95;

/** Positions worth judging: closed, honest, and in the window. */
const RECORD_SQL = `
  SELECT p.wallet, p.token, p.quote_in, p.quote_out, p.last_ts, l.pair_token
  FROM trader_positions p JOIN launches l USING(token)
  WHERE p.insider = 0 AND p.quote_in > 0 AND p.tokens_in > 0
    AND p.tokens_out >= p.tokens_in * ${CLOSED_AT}
    AND p.last_ts >= ?`;

type PositionRow = {
  wallet: string; token: string; quote_in: number; quote_out: number; last_ts: number; pair_token: string;
};

/** Dollars, using the same hand-maintained price book the cards use. */
function usd(db: DB, quote: number, pairToken: string): number | null {
  const q = quoteFromCache(db, pairToken);
  const px = usdOf(q.symbol);
  return px === null ? null : quote * px;
}

function fold(db: DB, rows: PositionRow[]): Map<string, TraderRecord> {
  const out = new Map<string, TraderRecord>();
  for (const r of rows) {
    const inUsd = usd(db, r.quote_in, r.pair_token);
    const outUsd = usd(db, r.quote_out, r.pair_token);
    // A position in an asset with no price is dropped rather than counted at zero: counting it would
    // read as a total loss and quietly punish everybody who traded an unpriced quote asset.
    if (inUsd === null || outUsd === null || inUsd <= 0) continue;

    const rec = out.get(r.wallet) ?? {
      wallet: r.wallet, closed: 0, wins: 0, realisedUsd: 0, winRate: 0, bestMultiple: 0, lastTs: 0,
    };
    rec.closed++;
    rec.realisedUsd += outUsd - inUsd;
    if (outUsd > inUsd) rec.wins++;
    rec.bestMultiple = Math.max(rec.bestMultiple, outUsd / inUsd);
    rec.lastTs = Math.max(rec.lastTs, r.last_ts);
    out.set(r.wallet, rec);
  }
  for (const rec of out.values()) rec.winRate = rec.closed ? rec.wins / rec.closed : 0;
  return out;
}

/** One wallet's record. Null when it has not closed enough to have one. */
export function recordOf(db: DB, wallet: string, since = 0): TraderRecord | null {
  const rows = db.prepare(`${RECORD_SQL} AND p.wallet = ?`).all(since, wallet.toLowerCase()) as PositionRow[];
  const rec = fold(db, rows).get(wallet.toLowerCase());
  return rec ?? null;
}

/**
 * The leaderboard.
 *
 * Ranked by realised dollars rather than by win rate, with the win rate printed beside it. A win
 * rate alone rewards a wallet that takes a hundred tiny profits and one enormous loss, and dollars
 * alone reward size over judgement; showing both lets a reader decide which they were looking at.
 */
export function leaderboard(db: DB, opts: { since?: number; minClosed?: number; limit?: number } = {}): TraderRecord[] {
  const since = opts.since ?? 0;
  const minClosed = opts.minClosed ?? CFG.traderMinClosed;
  const rows = db.prepare(RECORD_SQL).all(since) as PositionRow[];
  return [...fold(db, rows).values()]
    .filter((r) => r.closed >= minClosed)
    .sort((a, b) => b.realisedUsd - a.realisedUsd)
    .slice(0, opts.limit ?? 50);
}

/** Whether a wallet has enough of a record for its arrival in a token to be worth a message. */
export function isRanked(db: DB, wallet: string, since = 0): TraderRecord | null {
  const rec = recordOf(db, wallet, since);
  return rec && rec.closed >= CFG.traderMinClosed && rec.realisedUsd > 0 ? rec : null;
}

/* ── what a chat is watching ────────────────────────────────────────────────── */

export const watchToken = (db: DB, chatId: number, token: string, now: number): boolean => {
  const t = token.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(t)) return false;
  db.prepare("INSERT INTO tg_holdings (chat_id, token, created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING")
    .run(chatId, t, now);
  return true;
};

export const unwatchToken = (db: DB, chatId: number, token: string): void => {
  db.prepare("DELETE FROM tg_holdings WHERE chat_id = ? AND token = ?").run(chatId, token.toLowerCase());
};

export const watchedBy = (db: DB, chatId: number): string[] =>
  (db.prepare("SELECT token FROM tg_holdings WHERE chat_id = ? ORDER BY created_at").all(chatId) as
    Array<{ token: string }>).map((r) => r.token);

export const watchersOfToken = (db: DB, token: string): number[] =>
  (db.prepare("SELECT chat_id FROM tg_holdings WHERE token = ?").all(token.toLowerCase()) as
    Array<{ chat_id: number }>).map((r) => r.chat_id);

export type TraderHit = {
  chatId: number; token: string; wallet: string; record: TraderRecord;
  quote: number; quoteSymbol: string; ts: number;
};

/**
 * Ranked wallets that have just opened a position in a token somebody is watching.
 *
 * Opened, not added to: a wallet buying more of what it already holds is not news, and announcing
 * every buy would turn one decision into a stream. The dedupe table makes that permanent per chat,
 * per token, per wallet.
 */
export function pendingTraderAlerts(db: DB, since: number, limit = 25): TraderHit[] {
  const rows = db.prepare(`
    SELECT p.wallet, p.token, p.quote_in, p.first_ts, l.pair_token
    FROM trader_positions p
    JOIN tg_holdings h ON h.token = p.token
    JOIN launches l ON l.token = p.token
    WHERE p.first_ts >= ? AND p.insider = 0 AND p.buys > 0
    GROUP BY p.wallet, p.token
    ORDER BY p.first_ts DESC LIMIT 200`).all(since) as
    Array<{ wallet: string; token: string; quote_in: number; first_ts: number; pair_token: string }>;

  const already = db.prepare("SELECT 1 x FROM tg_trader_sent WHERE chat_id = ? AND token = ? AND wallet = ?");
  const out: TraderHit[] = [];
  for (const r of rows) {
    const record = isRanked(db, r.wallet);
    if (!record) continue;
    const q = quoteFromCache(db, r.pair_token);
    for (const chatId of watchersOfToken(db, r.token)) {
      if (already.get(chatId, r.token, r.wallet)) continue;
      out.push({
        chatId, token: r.token, wallet: r.wallet, record,
        quote: r.quote_in, quoteSymbol: q.symbol, ts: r.first_ts,
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export const markTraderSent = (db: DB, chatId: number, token: string, wallet: string, now: number): void => {
  db.prepare(`INSERT INTO tg_trader_sent (chat_id, token, wallet, sent_at) VALUES (?,?,?,?)
    ON CONFLICT DO NOTHING`).run(chatId, token.toLowerCase(), wallet.toLowerCase(), now);
};

/** What the board says about the trader index, for the page that reports on itself. */
export function traderCounts(db: DB): { positions: number; wallets: number; ranked: number } {
  const r = db.prepare("SELECT count(*) positions, count(DISTINCT wallet) wallets FROM trader_positions")
    .get() as { positions: number; wallets: number };
  return { ...r, ranked: leaderboard(db, { limit: 100_000 }).length };
}
