import { walletPeaks, type PastPeak } from "./card.ts";
import type { DB } from "./db.ts";
import type { Tier } from "./tiers.ts";
import { HORIZON_SEC } from "./track.ts";

/**
 * Following a wallet: the one alert that is not about a score.
 *
 * Everything else the bot sends starts from the model — a launch is worth a message because it
 * ranked. This starts from the reader instead. Somebody who watched a wallet graduate three tokens
 * has a claim about that wallet the model cannot make, because the model scores a launch on what it
 * looks like and not on who made it, and a wallet with a record is exactly the kind of fact that a
 * score built from thirty thousand launches averages away.
 *
 * So a followed wallet's launch goes out whatever it scored, and it goes out at once. What is capped
 * is how many wallets a chat may hold, not what it may be told about them: a limit on the promise
 * would make the feature not worth having, while a limit on the list keeps the cost bounded and is
 * the thing a holder can pay to lift.
 *
 * Kept apart from the bot for the usual reason: the rules are a pure function of the database and a
 * clock, and a rule that can be driven from a test without a network is a rule that gets tested.
 */

/** How many wallets a chat may follow, by what it holds. */
export const FOLLOW_CAP: Record<Tier, number> = { 0: 3, 1: 25, 2: 100 };

export const isAddress = (s: string): boolean => /^0x[0-9a-f]{40}$/.test(s.trim().toLowerCase());

export type FollowRow = { address: string; created_at: number };

export const followsOf = (db: DB, chatId: number): FollowRow[] =>
  db.prepare("SELECT address, created_at FROM tg_follows WHERE chat_id = ? ORDER BY created_at")
    .all(chatId) as FollowRow[];

export const followSet = (db: DB, chatId: number): Set<string> =>
  new Set(followsOf(db, chatId).map((f) => f.address));

export type FollowResult =
  | { ok: true; count: number }
  | { ok: false; reason: "already" | "full"; count: number };

/**
 * Adds a wallet to a chat's list, if there is room.
 *
 * The cap is passed in rather than read here so the caller decides what the reader's tier is worth
 * today; this only enforces it. Following the same wallet twice is not an error worth a different
 * outcome than the first time, but it is worth saying, because a reader who typed it again probably
 * expected something to happen.
 */
export function follow(db: DB, chatId: number, address: string, now: number, cap: number): FollowResult {
  const a = address.trim().toLowerCase();
  const count = followsOf(db, chatId).length;
  if (db.prepare("SELECT 1 x FROM tg_follows WHERE chat_id = ? AND address = ?").get(chatId, a)) {
    return { ok: false, reason: "already", count };
  }
  if (count >= cap) return { ok: false, reason: "full", count };
  db.prepare("INSERT INTO tg_follows (chat_id, address, created_at) VALUES (?,?,?)").run(chatId, a, now);
  return { ok: true, count: count + 1 };
}

export function unfollow(db: DB, chatId: number, address: string): boolean {
  const before = followsOf(db, chatId).length;
  db.prepare("DELETE FROM tg_follows WHERE chat_id = ? AND address = ?").run(chatId, address.trim().toLowerCase());
  return followsOf(db, chatId).length < before;
}

/** Every chat that follows any wallet at all. The alert pass skips the rest without reading them. */
export const followingChats = (db: DB): number[] =>
  (db.prepare("SELECT DISTINCT chat_id FROM tg_follows").all() as Array<{ chat_id: number }>)
    .map((r) => r.chat_id);

export type WalletRecord = {
  address: string;
  launches: number;
  graduations: number;
  /** Their share against the roughly 2% of all launches that graduate, or null with nothing to go on. */
  gradRate: number | null;
  lastTs: number | null;
  best: PastPeak | null;
  /** Curves of theirs nobody has read, so `best` is a floor rather than a claim about all of them. */
  unread: number;
};

/**
 * What a wallet has done, by both names it can go by.
 *
 * `launch_sender` is the wallet a card calls the creator and `deployer` is the address the factory
 * event names; they differ on about a sixth of launches, where the transaction went through a
 * contract. Matching either is what makes an address copied off a card mean the same thing here as
 * it did there.
 */
export function walletRecord(db: DB, address: string, except?: string): WalletRecord {
  const a = address.trim().toLowerCase();
  // A record shown beside a launch is the record *before* it, the way a card reads a creator's
  // history: counting the launch being announced makes "last launch 3s ago" point at the message
  // the reader is holding, and turns one graduation in thirty into one in thirty-one for no reason.
  const skip = except ? " AND l.token != ?" : "";
  const mine = `(l.launch_sender = ? OR l.deployer = ?)${skip}`;
  const args = except ? [a, a, except.toLowerCase()] : [a, a];

  const tally = db.prepare(`SELECT count(*) c, max(l.ts) last FROM launches l WHERE ${mine}`)
    .get(...args) as { c: number; last: number | null };
  const grad = db.prepare(`
    SELECT count(*) c FROM launches l JOIN graduations g ON g.token = l.token WHERE ${mine}`)
    .get(...args) as { c: number };
  const unread = db.prepare(`
    SELECT count(*) c FROM launches l
    WHERE ${mine} AND l.token NOT IN (SELECT token FROM curve_indexed)
      AND l.token NOT IN (SELECT token FROM curve_summary)`).get(...args) as { c: number };

  return {
    address: a,
    launches: tally.c,
    graduations: grad.c,
    gradRate: tally.c > 0 ? grad.c / tally.c : null,
    lastTs: tally.last,
    best: walletPeaks(db, a, 1)[0] ?? null,
    unread: unread.c,
  };
}

/**
 * What share of launches reach the pool, measured here rather than quoted.
 *
 * A wallet's record means nothing without it: two graduations out of thirty-one is either twice
 * typical or half of it, and which one decides whether following that wallet was a good idea. Only
 * launches old enough to have settled are counted, because the last four hours are full of launches
 * whose answer is still open and counting them as failures would flatter every wallet on the board
 * against a base rate that is too low.
 */
export function baseGradRate(db: DB, now = Math.floor(Date.now() / 1000)): number | null {
  const cutoff = now - HORIZON_SEC;
  const n = (db.prepare("SELECT count(*) c FROM launches WHERE ts <= ?").get(cutoff) as { c: number }).c;
  if (n < 100) return null;
  const g = (db.prepare(`
    SELECT count(*) c FROM launches l JOIN graduations g ON g.token = l.token WHERE l.ts <= ?`)
    .get(cutoff) as { c: number }).c;
  return g / n;
}

export type RecentLaunch = {
  token: string;
  ts: number;
  symbol: string | null;
  name: string | null;
  sender: string | null;
  deployer: string;
};

/**
 * Launches inside a window, read once for every chat that follows anything.
 *
 * The window is minutes wide rather than seconds, and that is deliberate. A launch arrives with only
 * the deployer the event carried; `launch_sender` is filled a few seconds later, when the watcher
 * reads the transaction. A pass that asked only about the last second would look at a row whose
 * creator column is still empty, decide nobody follows it, and never look again. Sending is deduped
 * against `tg_sent`, so a wider window costs a second look rather than a second message.
 *
 * The row limit is set against the arrival rate rather than picked round: the chain produces roughly
 * 215 launches in ten minutes, so five hundred is about twice the window, and a launch cannot fall
 * off the end of the list before anybody has looked at it.
 */
export const recentLaunches = (db: DB, since: number, limit = 500): RecentLaunch[] =>
  db.prepare(`
    SELECT token, ts, symbol, name, launch_sender sender, deployer
    FROM launches WHERE ts >= ? ORDER BY ts DESC LIMIT ?`).all(since, limit) as RecentLaunch[];

/** Which followed wallet a launch belongs to, or null when it belongs to none of them. */
export function followedBy(row: RecentLaunch, follows: Set<string>): string | null {
  const sender = row.sender?.toLowerCase() ?? null;
  if (sender && follows.has(sender)) return sender;
  const deployer = row.deployer.toLowerCase();
  return follows.has(deployer) ? deployer : null;
}
