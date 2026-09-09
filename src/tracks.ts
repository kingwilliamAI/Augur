import type { DB } from "./db.ts";
import type { Tier } from "./tiers.ts";

/**
 * Tokens a reader is holding and wants watched, and who has been named to them already.
 *
 * The alert is "somebody with a record just bought this", so the list has to be small and the
 * watching has to be real: unlike everything else the bot sends, this one cannot be answered out of
 * what the watcher already collected. Curve trades are read per token and on demand, so each tracked
 * token is one `eth_getLogs` per pass, and the cap on the list is what keeps that bounded.
 *
 * Tracking starts from the block it was asked at, never from the launch. A list of everyone who ever
 * bought would be history, and this is meant to be a warning; being told at midnight about a wallet
 * that entered at noon is worse than not being told at all, because it reads like news.
 */

/** How many tokens a chat may watch at once, by what it holds. */
export const TRACK_CAP: Record<Tier, number> = { 0: 2, 1: 10, 2: 25 };

export type TrackRow = { token: string; from_block: number; created_at: number };

export const tracksOf = (db: DB, chatId: number): TrackRow[] =>
  db.prepare("SELECT token, from_block, created_at FROM tg_tracks WHERE chat_id = ? ORDER BY created_at")
    .all(chatId) as TrackRow[];

export type TrackResult =
  | { ok: true; count: number }
  | { ok: false; reason: "already" | "full" | "unknown" | "closed"; count: number };

/**
 * Starts watching one token for this chat.
 *
 * A launch that has already graduated is refused rather than accepted and left silent: trading moves
 * to the pool at graduation and the curve this watches goes quiet forever, so accepting it would be
 * promising alerts that can no longer happen.
 */
export function track(db: DB, chatId: number, token: string, fromBlock: number, now: number, cap: number): TrackResult {
  const t = token.trim().toLowerCase();
  const count = tracksOf(db, chatId).length;
  const launch = db.prepare("SELECT token FROM launches WHERE token = ?").get(t) as { token: string } | undefined;
  if (!launch) return { ok: false, reason: "unknown", count };
  if (db.prepare("SELECT 1 x FROM graduations WHERE token = ?").get(t)) return { ok: false, reason: "closed", count };
  if (db.prepare("SELECT 1 x FROM tg_tracks WHERE chat_id = ? AND token = ?").get(chatId, t)) {
    return { ok: false, reason: "already", count };
  }
  if (count >= cap) return { ok: false, reason: "full", count };
  db.prepare("INSERT INTO tg_tracks (chat_id, token, from_block, created_at) VALUES (?,?,?,?)")
    .run(chatId, t, fromBlock, now);
  return { ok: true, count: count + 1 };
}

export function untrack(db: DB, chatId: number, token: string): boolean {
  const t = token.trim().toLowerCase();
  const before = tracksOf(db, chatId).length;
  db.prepare("DELETE FROM tg_tracks WHERE chat_id = ? AND token = ?").run(chatId, t);
  db.prepare("DELETE FROM tg_trader_sent WHERE chat_id = ? AND token = ?").run(chatId, t);
  return tracksOf(db, chatId).length < before;
}

export type TrackedToken = { token: string; curve: string; block: number; fromBlock: number; graduated: boolean };

/**
 * Every token anybody is watching, once each.
 *
 * Reading a curve is per token and not per subscriber, so two chats holding the same launch cost one
 * request between them. `fromBlock` is the earliest any of them started, because a chat that started
 * later filters the same rows down for itself.
 */
export const trackedTokens = (db: DB): TrackedToken[] =>
  db.prepare(`
    SELECT t.token, l.curve, l.block, min(t.from_block) fromBlock, (g.token IS NOT NULL) graduated
    FROM tg_tracks t
    JOIN launches l ON l.token = t.token
    LEFT JOIN graduations g ON g.token = t.token
    GROUP BY t.token`).all().map((r) => {
      const row = r as { token: string; curve: string; block: number; fromBlock: number; graduated: number };
      return { ...row, graduated: Boolean(row.graduated) };
    });

/** Chats watching one token, with the block each of them started from. */
export const watchersOf = (db: DB, token: string): Array<{ chat_id: number; from_block: number }> =>
  db.prepare("SELECT chat_id, from_block FROM tg_tracks WHERE token = ?").all(token.toLowerCase()) as
    Array<{ chat_id: number; from_block: number }>;

export type Buyer = {
  address: string;
  /** Their first buy since watching began. */
  block: number;
  /** Everything they have put in since then, in raw quote units. */
  quote: number;
  /** Quote units per token unit at that first buy, before decimals are applied. */
  entryPrice: number;
};

/**
 * Who has bought this token since a given block, one row per wallet.
 *
 * Grouped by wallet rather than listed per trade because the alert is about somebody arriving, not
 * about each transaction they sign; a wallet buying in five clips is one arrival. Wallets this chat
 * has already been told about on this token are left out here rather than filtered afterwards, so a
 * quiet pass costs one query and no work at all.
 */
export function newBuyers(db: DB, chatId: number, token: string, fromBlock: number, limit = 25): Buyer[] {
  return db.prepare(`
    WITH b AS (
      SELECT recipient, block, log_index, CAST(quote_wei AS REAL) q,
             CAST(quote_wei AS REAL) / CAST(token_amt AS REAL) px,
             row_number() OVER (PARTITION BY recipient ORDER BY block, log_index) rn
      FROM curve_trades
      WHERE token = ? AND side = 'buy' AND block > ? AND CAST(token_amt AS REAL) > 0
    )
    SELECT recipient address, min(block) block, sum(q) quote,
           max(CASE WHEN rn = 1 THEN px END) entryPrice
    FROM b
    WHERE recipient NOT IN (SELECT trader FROM tg_trader_sent WHERE chat_id = ? AND token = ?)
    GROUP BY recipient
    ORDER BY min(block)
    LIMIT ?`).all(token.toLowerCase(), fromBlock, chatId, token.toLowerCase(), limit) as Buyer[];
}

export const markTraderSent = (db: DB, chatId: number, token: string, trader: string, now: number): void => {
  db.prepare(`INSERT INTO tg_trader_sent (chat_id, token, trader, sent_at) VALUES (?,?,?,?)
    ON CONFLICT DO NOTHING`).run(chatId, token.toLowerCase(), trader.toLowerCase(), now);
};

/**
 * Stops watching a token that has graduated, and says which chats were watching it.
 *
 * Left to expire on its own rather than by a sweep with its own clock: the pass that reads curves is
 * the one that notices, and it is the only place where "the curve went quiet" and "we stopped
 * looking" can be told apart.
 */
export function retireGraduated(db: DB, token: string): number[] {
  const chats = watchersOf(db, token).map((w) => w.chat_id);
  db.prepare("DELETE FROM tg_tracks WHERE token = ?").run(token.toLowerCase());
  db.prepare("DELETE FROM tg_trader_sent WHERE token = ?").run(token.toLowerCase());
  return chats;
}
