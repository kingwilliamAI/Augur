import { existsSync, readFileSync } from "node:fs";
import { advanceCursor, buildDataset, openCursor, FEATURES, type Cursor, type Row } from "./features.ts";
import { deserialize, predict, type GbdtModel } from "./model/gbdt.ts";
import { explain, type Reason } from "./model/reasons.ts";
import { applyLive, liveFor } from "./calibration.ts";
import { modelId } from "./track.ts";
import type { DB } from "./db.ts";

export type Scored = {
  token: string;
  /**
   * The model's own probability, before any live correction. The card shows `probability`; this is
   * what a refit must be fitted against, or a correction would be measured on top of itself.
   */
  rawProbability: number;
  /** Launch time, so the caller can order by recency without a second query. */
  ts: number;
  probability: number;
  /** Rank among launches from the last `windowHours`, 1 = most likely to graduate. */
  rank: number;
  of: number;
  percentile: number;
  reasons: Reason[];
};

/**
 * One feature matrix, shared by the feed and every card.
 *
 * Rebuilding it costs about five seconds at 166,000 enriched launches, so who rebuilds it and when
 * is the difference between a board that answers instantly and one that takes fifteen seconds to
 * open a card.
 *
 * What makes a cache safe here: **rows for past launches never change**. Features are computed from
 * history strictly earlier than the launch's own timestamp, and a graduation happening now is later
 * than every launch already in the matrix, so it cannot alter one. A cached matrix is therefore
 * never wrong about what it holds — only ever incomplete. That turns the question from "is this
 * stale" into "is the row I need present", which has a cheap answer.
 *
 * So the two callers ask for different things. A card names one launch and is served from the cache
 * whenever that launch is in it. The feed wants whatever is newest and accepts being a few seconds
 * behind, which is what the staleness shown on the board is for.
 */
const REBUILD_AFTER_MS = 15_000;
/** Rounding `since` keeps a clock that moves every second from invalidating the cache every second. */
const SINCE_BUCKET_SEC = 60;

let cached: { rows: Row[]; tokens: Set<string>; builtAt: number; since: number; cursor: Cursor } | null = null;

/**
 * Rows for the window, carried forward rather than rebuilt.
 *
 * A rebuild is a five-second pass over every launch ever seen, and the board wanted one every
 * fifteen seconds. On a single thread that is a third of the time spent answering nobody: the feed
 * swung between half a second and nine, and every other page waited behind it. Advancing the cursor
 * reads only what arrived since the last pass, which is milliseconds.
 *
 * A full open is still needed twice: the first time, and whenever a caller asks for a window wider
 * than the one in hand, which needs history the cursor has already let go of.
 */
function rebuild(db: DB, since: number): Row[] {
  const cursor = openCursor(db, since);
  cached = { rows: cursor.rows, tokens: new Set(cursor.rows.map((r) => r.token)), builtAt: Date.now(), since, cursor };
  return cursor.rows;
}

function advance(db: DB, since: number): Row[] | null {
  if (!cached || !advanceCursor(db, cached.cursor, since)) return null;
  cached.rows = cached.cursor.rows;
  cached.tokens = new Set(cached.rows.map((r) => r.token));
  cached.builtAt = Date.now();
  cached.since = since;
  return cached.rows;
}

/** How far behind the matrix is, in seconds. Surfaced so the board can say so out loud. */
export function datasetAgeSec(): number | null {
  return cached ? Math.round((Date.now() - cached.builtAt) / 1000) : null;
}

/**
 * For the feed: rows back to `since`, newest data preferred, a few seconds behind is fine.
 *
 * A cache built for a longer reach answers a shorter question too, so it is only advanced when the
 * clock says it is worth doing, and only rebuilt when the request needs history the cursor let go.
 */
export function dataset(db: DB, since: number): Row[] {
  const want = Math.floor(since / SINCE_BUCKET_SEC) * SINCE_BUCKET_SEC;
  if (!cached) return rebuild(db, want);
  if (Date.now() - cached.builtAt <= REBUILD_AFTER_MS && cached.since <= want) return cached.rows;
  return advance(db, want) ?? rebuild(db, want);
}

/**
 * Whatever matrix is already in hand, or nothing.
 *
 * For readers that want the rows but do not need them current, and must not be the one paying for a
 * rebuild. The model page is the case: feature influence moves over days.
 */
/**
 * Which build of the matrix is in hand.
 *
 * Callers that cache an answer derived from it key on this: while it is unchanged the rows are
 * unchanged, so the answer is not stale, it is the same answer.
 */
/**
 * Every score in the window, sorted, held for as long as the rows are.
 *
 * A card shows where its launch stands among the window, and working that out meant scoring the
 * whole window again: eleven thousand rows through three hundred trees, 588 ms, for one card. The
 * feed had already done exactly that work a moment earlier. Held here, a rank costs a binary search.
 */
let peerCache: { version: number; hours: number; calibration: string; sorted: Float64Array } | null = null;

function peerScores(rows: Row[], model: GbdtModel, cutoff: number, hours: number, c: { a: number; b: number } | null): Float64Array {
  const version = datasetVersion();
  const calibration = c ? `${c.a}:${c.b}` : "-";
  if (peerCache && peerCache.version === version && peerCache.hours === hours && peerCache.calibration === calibration) {
    return peerCache.sorted;
  }
  const inWindow = rows.filter((r) => r.ts >= cutoff);
  const sorted = new Float64Array(inWindow.length);
  for (let i = 0; i < inWindow.length; i++) sorted[i] = corrected(predict(model, inWindow[i].x), c);
  sorted.sort();
  peerCache = { version, hours, calibration, sorted };
  return sorted;
}

/** How many held scores are strictly greater than `p`, by binary search over the ascending array. */
function betterThan(sorted: Float64Array, p: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] > p) hi = mid;
    else lo = mid + 1;
  }
  return sorted.length - lo;
}

export function datasetVersion(): number {
  return cached ? cached.builtAt : 0;
}

export function datasetCachedOnly(): Row[] | null {
  return cached ? cached.rows : null;
}

export function datasetWith(db: DB, token: string): Row[] {
  if (cached?.tokens.has(token)) return cached.rows;
  // Cheap first: a launch this recent is almost always one the cursor has simply not reached yet.
  if (cached && advance(db, cached.since) && cached.tokens.has(token)) return cached.rows;
  const rows = rebuild(db, cached?.since ?? Math.floor(Date.now() / 1000) - 6 * 3600);
  if (cached?.tokens.has(token)) return rows;
  return rebuild(db, 0);
}

/**
 * The correction fitted against the live prediction log, when one exists for the model in use.
 *
 * Read per call rather than cached: it is a tiny file, it changes at most a few times a day, and a
 * board that kept serving a stale correction after a retrain would be printing numbers the log can
 * no longer vouch for. `liveFor` already refuses a correction stamped with a different model.
 */
function live(): { a: number; b: number } | null {
  try {
    return liveFor(modelId());
  } catch {
    return null;
  }
}

/**
 * The probability as shown: the model's own, then the live correction if there is one.
 *
 * Not named `shown`: `scoreRecent` already binds that for its display ordering, and a module-level
 * function of the same name is shadowed by it throughout the function body — including above the
 * binding, where the local is still in its dead zone. That reads as a plain reference and throws at
 * runtime on the first feed request, which is to say in production and not in any test.
 */
export function corrected(p: number, c: { a: number; b: number } | null): number {
  return c ? applyLive(c, p) : p;
}

export function loadModel(path = "./data/model.json"): GbdtModel | null {
  if (!existsSync(path)) return null;
  return deserialize(readFileSync(path, "utf8"));
}

/**
 * Scores every launch in a recent window and ranks them against each other.
 *
 * A bare probability is hard to act on when the base rate is 2.5%: "3.9%" means little until you
 * know it is the highest of the last two hundred launches. The rank is what makes the number usable,
 * so it is computed here rather than left to the caller.
 */
export type FeedOrder = "score" | "new";

/**
 * Scores every launch in a recent window and ranks them against each other.
 *
 * A bare probability is hard to act on when the base rate is 2.2%: "3.9%" means little until you
 * know it is the highest of the last two thousand launches. The rank is what makes the number
 * usable, so it is computed here rather than left to the caller.
 *
 * `order` changes the reading order only. The rank is always by score, in both orders, because a
 * "#1" that meant "most recent" would be worthless — the point of showing a fresh launch is to see
 * where it lands against everything else, not to be told it is new.
 */
/**
 * One page of the feed, with the counts needed to describe it honestly.
 *
 * `total` is every launch in the window and `matched` is how many cleared the reader's threshold,
 * so a capped list can say "showing 150 of 300 that scored 5% or better, out of 4,665" instead of
 * implying the window holds only what fits on screen.
 */
export type FeedPage = { items: Scored[]; matched: number; total: number };

export function scoreRecent(
  db: DB, model: GbdtModel, windowHours = 6, limit = 200, order: FeedOrder = "score", minP = 0,
): FeedPage {
  const cutoff = Math.floor(Date.now() / 1000) - windowHours * 3600;
  const rows = dataset(db, cutoff).filter((r) => r.ts >= cutoff);
  if (!rows.length) return { items: [], matched: 0, total: 0 };

  const c = live();
  const scored = rows
    .map((r) => { const raw = predict(model, r.x); return { token: r.token, ts: r.ts, x: r.x, raw, p: corrected(raw, c) }; })
    .sort((a, b) => b.p - a.p);

  const ranked = scored.map((s, i) => ({
    token: s.token,
    ts: s.ts,
    x: s.x,
    rawProbability: s.raw,
    probability: s.p,
    rank: i + 1,
    of: scored.length,
    percentile: 100 * (1 - i / Math.max(1, scored.length - 1)),
  }));

  // Filtered after ranking, so a rank means the same thing whatever the reader has hidden: #264 of
  // 4,537 is its place among every launch in the window, not among the survivors of a threshold.
  // Filtered before the cap, though, so a threshold reaches the whole window rather than merely
  // thinning the first hundred and fifty rows.
  const kept = minP > 0 ? ranked.filter((r) => r.probability >= minP) : ranked;

  const shown = order === "new"
    ? [...kept].sort((a, b) => b.ts - a.ts || a.rank - b.rank).slice(0, limit)
    : kept.slice(0, limit);

  return {
    items: shown.map(({ x, ...rest }) => ({ ...rest, reasons: explain(model, x, 3) })),
    matched: kept.length,
    total: scored.length,
  };
}

/** Scores one launch and places it against the same recent window. */
export function scoreOne(db: DB, model: GbdtModel, token: string, windowHours = 6): Scored | null {
  const cutoff = Math.floor(Date.now() / 1000) - windowHours * 3600;
  const rows = datasetWith(db, token.toLowerCase());
  const me = rows.find((r) => r.token === token.toLowerCase());
  if (!me) return null;

  const c = live();
  const raw = predict(model, me.x);
  const p = corrected(raw, c);
  const peers = peerScores(rows, model, cutoff, windowHours, c);
  const better = betterThan(peers, p);
  return {
    token: me.token,
    ts: me.ts,
    rawProbability: raw,
    probability: p,
    rank: better + 1,
    of: Math.max(peers.length, 1),
    percentile: 100 * (1 - better / Math.max(1, peers.length - 1)),
    reasons: explain(model, me.x, 3),
  };
}

export { FEATURES };
