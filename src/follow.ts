import { CFG } from "./config.ts";
import type { DB } from "./db.ts";
import { quotePerToken } from "./pool.ts";
import { marketCapUsd } from "./prices.ts";
import { quoteFromCache } from "./quote.ts";
import { tierOf, type Tier } from "./tiers.ts";

/**
 * Following a creator: who is watched, by whom, and what their record actually is.
 *
 * Kept out of the bot for the same reason the tier rules are: the bot is a long-poll loop that
 * cannot be tested, and the questions it asks here can. Everything below is a pure function of the
 * database.
 *
 * The address followed is the wallet that sent the launch transaction, not the deployer the factory
 * event names. They differ on about a sixth of launches, and Multicall3 sits in the deployer column
 * for thousands of launches by thousands of unrelated people: following that address would mean
 * following everybody at once, which is not a feature anyone asked for.
 */

/** How many creators a tier may follow. Tier 2 is uncapped, which is what the roadmap promised. */
export function followLimit(tier: Tier): number {
  return tier >= 2 ? Infinity : tier === 1 ? CFG.followLimitTier1 : 0;
}

export const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

export type FollowResult =
  | { ok: true; address: string; count: number }
  | { ok: false; reason: "bad-address" | "not-a-holder" | "limit" | "already" | "shared"; limit?: number; senders?: number };

/**
 * Whether an address is a deployer many unrelated people launch through.
 *
 * Multicall3 is the second busiest address in the deployer column and it is nobody's creator. A
 * follow on it would not be a subscription, it would be a firehose of everybody who happened to
 * batch a call that day, and the reader would blame the bot rather than their own choice of address.
 *
 * Measured by distinct senders rather than by a hardcoded list, so a router nobody has heard of yet
 * is caught by the same rule on the day it becomes popular.
 */
export function sharedDeployer(db: DB, address: string): number {
  const r = db.prepare(`SELECT count(DISTINCT launch_sender) n FROM launches
    WHERE deployer = ? AND launch_sender IS NOT NULL AND launch_sender <> deployer`)
    .get(address.toLowerCase()) as { n: number };
  return r.n;
}

export function follow(db: DB, chatId: number, address: string, now: number): FollowResult {
  const a = address.trim().toLowerCase();
  if (!ADDRESS_RE.test(a)) return { ok: false, reason: "bad-address" };

  const limit = followLimit(tierOf(db, chatId));
  if (limit <= 0) return { ok: false, reason: "not-a-holder" };

  const senders = sharedDeployer(db, a);
  if (senders >= 2) return { ok: false, reason: "shared", senders };

  const existing = following(db, chatId);
  if (existing.includes(a)) return { ok: false, reason: "already" };
  // Counted against the limit before the insert rather than after, so the message a reader gets is
  // "you are at five" rather than "you were at five and now you are at six".
  if (existing.length >= limit) return { ok: false, reason: "limit", limit };

  db.prepare("INSERT INTO follows (chat_id, address, created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING")
    .run(chatId, a, now);
  return { ok: true, address: a, count: existing.length + 1 };
}

export function unfollow(db: DB, chatId: number, address: string): boolean {
  const a = address.trim().toLowerCase();
  const before = following(db, chatId).length;
  db.prepare("DELETE FROM follows WHERE chat_id = ? AND address = ?").run(chatId, a);
  return following(db, chatId).length < before;
}

export const following = (db: DB, chatId: number): string[] =>
  (db.prepare("SELECT address FROM follows WHERE chat_id = ? ORDER BY created_at").all(chatId) as
    Array<{ address: string }>).map((r) => r.address);

/**
 * Chats watching one creator: subscribed, still holding, and following since before this launch.
 *
 * Three conditions, each for its own reason. A chat that sent /stop is gone from tg_subs and must
 * hear nothing at all, whatever else it is still listed in. A tier that has lapsed stops delivery
 * without erasing the list, because the list may be wanted back next week. And a follow only counts
 * for launches after it was created, which is the rule this bot already wrote down for its score
 * alerts: subscribing starts the clock rather than emptying the last ten minutes into the chat.
 *
 * A subscription outlives the balance that bought it, and deleting follows the moment somebody sells
 * would lose a list they may want back next week. So the row stays and the delivery checks: selling
 * stops the alerts, it does not erase what you were watching.
 */
export const watchersOf = (db: DB, address: string, launchTs = 0): number[] =>
  (db.prepare(`SELECT f.chat_id FROM follows f
     JOIN tg_subs s ON s.chat_id = f.chat_id
     WHERE f.address = ? AND f.created_at <= ?`)
    .all(address.toLowerCase(), launchTs || Number.MAX_SAFE_INTEGER) as Array<{ chat_id: number }>)
    .map((r) => r.chat_id)
    .filter((chatId) => followLimit(tierOf(db, chatId)) > 0);

/** Everybody's follows, for the one query the alert path makes per pass. */
export const allFollowed = (db: DB): Set<string> =>
  new Set((db.prepare("SELECT DISTINCT address FROM follows").all() as Array<{ address: string }>)
    .map((r) => r.address));

export type CreatorRecord = {
  address: string;
  launches: number;
  graduations: number;
  bestUsd: number | null;
  bestSymbol: string | null;
  bestToken: string | null;
  firstSeen: number | null;
};

/**
 * What one creator has done, in the three places the answer can live.
 *
 * Written as an OR over two indexed columns rather than as coalesce(launch_sender, deployer),
 * because the tidier expression is a full scan: SQLite cannot use an index through a function, and
 * EXPLAIN QUERY PLAN says SCAN for one form and MULTI-INDEX OR for the other. Both columns are
 * already stored lowercased by ingest and enrich, so lower() bought nothing and cost the index.
 *
 * The board computes the same thing for every creator on screen at once and caches it for thirty
 * seconds; this answers for a single address, which is a different query and not worth sharing code
 * with. A peak can come from a live curve, from the folded summary that replaced it once the trades
 * were compacted away, or from the pool after graduation, and a creator's best is the best of all
 * three: leaving out any one of them under-reports exactly the creators worth following.
 */
export function creatorRecord(db: DB, address: string, exceptToken?: string): CreatorRecord {
  const a = address.toLowerCase();
  // A record that includes the launch it is describing is not a record, it is a mirror. The board
  // already learned this: it keeps the top two peaks per creator solely so a row can skip past
  // itself, having once printed $1.2M beside a card that said "first launch from this wallet".
  const skip = exceptToken?.toLowerCase() ?? "";
  const counts = db.prepare(`
    SELECT count(*) launches,
           sum(g.token IS NOT NULL) graduations,
           min(l.ts) first_seen
    FROM launches l LEFT JOIN graduations g USING(token)
    WHERE (l.launch_sender = ? OR (l.launch_sender IS NULL AND l.deployer = ?)) AND l.token <> ?`)
    .get(a, a, skip) as { launches: number; graduations: number | null; first_seen: number | null };

  let bestUsd: number | null = null;
  let bestSymbol: string | null = null;
  let bestToken: string | null = null;
  const consider = (usd: number | null, symbol: string | null, token: string): void => {
    if (usd === null || !Number.isFinite(usd)) return;
    if (bestUsd !== null && usd <= bestUsd) return;
    bestUsd = usd;
    bestSymbol = symbol;
    bestToken = token;
  };

  for (const r of db.prepare(`
    SELECT l.token, l.symbol, l.pair_token, c.peak_price peak
    FROM curve_summary c JOIN launches l USING(token)
    WHERE (l.launch_sender = ? OR (l.launch_sender IS NULL AND l.deployer = ?)) AND l.token <> ?`).all(a, a, skip) as
    Array<{ token: string; symbol: string | null; pair_token: string; peak: number }>) {
    const q = quoteFromCache(db, r.pair_token);
    consider(marketCapUsd(r.peak * (1e18 / 10 ** q.decimals), q.symbol), r.symbol, r.token);
  }

  for (const r of db.prepare(`
    SELECT l.token, l.symbol, l.pair_token,
           max(CAST(t.quote_wei AS REAL) / CAST(t.token_amt AS REAL)) peak
    FROM curve_trades t JOIN launches l ON l.token = t.token
    WHERE (l.launch_sender = ? OR (l.launch_sender IS NULL AND l.deployer = ?)) AND l.token <> ?
      AND CAST(t.token_amt AS REAL) > 0
    GROUP BY t.token`).all(a, a, skip) as
    Array<{ token: string; symbol: string | null; pair_token: string; peak: number }>) {
    const q = quoteFromCache(db, r.pair_token);
    consider(marketCapUsd(r.peak * (1e18 / 10 ** q.decimals), q.symbol), r.symbol, r.token);
  }

  for (const r of db.prepare(`
    SELECT l.token, l.symbol, l.pair_token, k.min_sqrt, k.max_sqrt, p.token_is_c1, p.dec0, p.dec1
    FROM pool_peaks k JOIN pools p ON p.pool_id = k.pool_id JOIN launches l ON l.token = p.token
    WHERE (l.launch_sender = ? OR (l.launch_sender IS NULL AND l.deployer = ?)) AND l.token <> ?`).all(a, a, skip) as
    Array<{ token: string; symbol: string | null; pair_token: string; min_sqrt: string;
            max_sqrt: string; token_is_c1: number; dec0: number; dec1: number }>) {
    const q = quoteFromCache(db, r.pair_token);
    // Where the token is currency1 the price rises as sqrtPriceX96 falls, so its peak is the low.
    const sqrt = r.token_is_c1 ? r.min_sqrt : r.max_sqrt;
    consider(marketCapUsd(quotePerToken(sqrt, r), q.symbol), r.symbol, r.token);
  }

  return {
    address: a,
    launches: counts.launches,
    graduations: counts.graduations ?? 0,
    bestUsd,
    bestSymbol,
    bestToken,
    firstSeen: counts.first_seen,
  };
}

/**
 * Launches by followed creators that a chat has not been told about.
 *
 * Driven by a timestamp watermark rather than by a scan of every launch: at twenty-five thousand a
 * day, asking "did anybody I follow launch" the naive way would read the whole table every second.
 * The watermark is deliberately generous — a minute of overlap — because the dedupe table is what
 * actually prevents a repeat, and a launch arriving a second late is worse than one considered twice.
 */
export type FollowHit = {
  token: string; ts: number; address: string; chatId: number;
  /** True when the launch came from the chat's own proved wallet rather than one it follows. */
  own: boolean;
};

/**
 * Chats whose own proved wallet is this address.
 *
 * Not gated by tier, and deliberately. Telling a creator where their own launch ranked is not a
 * thing being sold to them: it is a fact about their launch, computed from a claim this machine
 * wrote anyway, and charging for it would make the deployer tools a toll on the people they exist
 * for. Following somebody else stays paid, because that is somebody else's work being watched.
 */
export const ownersOf = (db: DB, address: string, launchTs = 0): number[] =>
  (db.prepare(`SELECT w.chat_id FROM wallet_links w
     JOIN tg_subs s ON s.chat_id = w.chat_id
     WHERE w.address = ? AND w.linked_at <= ?`)
    .all(address.toLowerCase(), launchTs || Number.MAX_SAFE_INTEGER) as Array<{ chat_id: number }>)
    .map((r) => r.chat_id);

export function pendingFollowAlerts(db: DB, since: number, limit = 50): FollowHit[] {
  const watched = allFollowed(db);
  const anyLinks = (db.prepare("SELECT count(*) c FROM wallet_links").get() as { c: number }).c > 0;
  if (!watched.size && !anyLinks) return [];

  // Both columns, not coalesce, because the two mean different things for the first three seconds
  // of a launch's life. The watcher enriches in batches, so launch_sender is null until it does, and
  // during that window coalesce quietly resolves to the deployer — which for a router launch is a
  // contract thousands of unrelated people share. A bounded window of rows, so the scan is cheap.
  const rows = db.prepare(`
    SELECT token, ts, launch_sender, deployer
    FROM launches WHERE ts >= ? ORDER BY ts DESC LIMIT 500`).all(since) as
    Array<{ token: string; ts: number; launch_sender: string | null; deployer: string }>;

  const already = db.prepare("SELECT 1 x FROM tg_follow_sent WHERE chat_id = ? AND token = ?");
  const out: FollowHit[] = [];
  for (const r of rows) {
    const dev = r.launch_sender ?? r.deployer;
    // A creator who also follows their own address gets one message rather than two, and it is the
    // one that knows the launch is theirs.
    const owners = ownersOf(db, dev, r.ts);
    const seen = new Set<number>();
    for (const chatId of owners) {
      if (already.get(chatId, r.token)) continue;
      seen.add(chatId);
      out.push({ token: r.token, ts: r.ts, address: dev, chatId, own: true });
      if (out.length >= limit) return out;
    }
    if (!watched.has(dev)) continue;
    for (const chatId of watchersOf(db, dev, r.ts)) {
      if (seen.has(chatId) || already.get(chatId, r.token)) continue;
      out.push({ token: r.token, ts: r.ts, address: dev, chatId, own: false });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export const markFollowSent = (db: DB, chatId: number, token: string, now: number): void => {
  db.prepare("INSERT INTO tg_follow_sent (chat_id, token, sent_at) VALUES (?,?,?) ON CONFLICT DO NOTHING")
    .run(chatId, token, now);
};

/** What the board says about following, for the page that reports on itself. */
export const followCounts = (db: DB): { chats: number; addresses: number } => {
  const r = db.prepare(`SELECT count(DISTINCT chat_id) chats, count(DISTINCT address) addresses
    FROM follows`).get() as { chats: number; addresses: number };
  return r;
};
