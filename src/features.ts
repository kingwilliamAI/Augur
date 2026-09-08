import type { DB } from "./db.ts";

/**
 * The feature vector, computed strictly from what is knowable the instant the launch transaction
 * lands. Nothing here reads a trade, a price, or an outcome.
 *
 * The subtle trap is creator history. A creator's earlier launch may graduate *after* the launch we
 * are scoring, so counting "their prior graduations" by the earlier launch's own timestamp leaks the
 * future. History is therefore accumulated by graduation time, not launch time.
 */
export const FEATURES = [
  "calldata_decoded",
  "exempt_count",
  "exempt_is_zero",
  "log_initial_buy",
  "initial_buy_is_zero",
  "creator_tax_bps",
  "buyback_enabled",
  "socials_count",
  "has_twitter",
  "has_website",
  "fee_redirected",
  "via_contract",
  "is_eth_quoted",
  "log_threshold",
  "desc_len",
  "symbol_len",
  "dev_prior_launches",
  "dev_prior_graduations",
  "dev_prior_grad_rate",
  "dev_is_first_launch",
  "exempt_seen_before",
  "hour_utc",
  "launches_prior_hour",
] as const;

/**
 * Name-cluster counts are deliberately NOT features, despite looking like the strongest signal in
 * the data. Measured over a 9-hour window: a ticker already launched 30+ times graduates at 3.17x
 * the base rate, and one whose earlier copies already reached the pool at 3.35x.
 *
 * Adding them to the model made it worse. On the rows where a ticker is actually readable, held-out
 * ROC fell from 0.744 to 0.724 and top-decile lift from 4.19x to 3.87x across five folds. The
 * information is real but already carried by creator history and launch congestion, so five
 * correlated columns bought variance and nothing else.
 *
 * The counts stay in the product as facts on the card (see `clusterInfo` in card.ts), where a human
 * reading "this ticker has launched 30 times, two reached the pool" is genuinely better informed.
 */

export type FeatureName = (typeof FEATURES)[number];
export type Row = { token: string; ts: number; block: number; label: 0 | 1; x: Float64Array };

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const log1p = (v: number): number => Math.log1p(Math.max(0, v));

/**
 * Collapses a ticker or name to a comparison key: case, spacing, punctuation and emoji all vary
 * between a token and the copies that chase it, and none of that variation is meaningful.
 */
export const normaliseName = (s: string | null): string =>
  (s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

type LaunchRow = {
  token: string; deployer: string; launch_sender: string | null; pair_token: string;
  graduation_threshold_wei: string; block: number; ts: number;
  creator_fee_recipient: string | null; creator_tax_bps: number | null; buyback_enabled: number | null;
  initial_buy_wei: string | null; quote_decimals: number | null; exempt_count: number | null;
  /** Only lengths are ever features, so the text itself never leaves SQLite. On 170,000 launches
   *  pulling full descriptions costs more than every other column put together. */
  symbol_len: number; desc_len: number;
  socials_json: string | null; grad_ts: number | null;
};

/** The columns needed to carry history forward, for launches that will not become rows themselves. */
type SpineRow = { token: string; deployer: string; block: number; ts: number; grad_ts: number | null };

/**
 * Builds the training matrix in block order, carrying per-creator state forward as it goes so every
 * row sees only its own past. Returns rows sorted by time, which is what the temporal split needs.
 *
 * `since` limits which launches become rows — not which are walked. History has to be accumulated
 * over every launch regardless, or a creator's record would start at the window edge, but a launch
 * outside the window needs only three columns to contribute to it. Reading the full feature columns
 * for all 170,000 launches costs four times as much as reading three, and the board asks about six
 * hours, which is five thousand of them. Same rows out, a quarter of the work.
 */
/** The four things a row needs from the walk over everything that came before it. */
export type History = { priorL: number; priorG: number; overlap: number; recentCount: number };

/**
 * One launch's feature vector.
 *
 * Pulled out so the full build and the incremental one cannot drift: they compute a row by calling
 * this, rather than by each carrying a copy of the same twenty-three assignments.
 */
function featureRow(r: LaunchRow, h: History, horizon: number): Row {
  const socials = (() => {
    try { return JSON.parse(r.socials_json ?? "{}") as Record<string, string>; } catch { return {}; }
  })();
  const socialVals = Object.values(socials).filter((v) => typeof v === "string" && v.length > 3);

  // Roughly half of launches do not go through the router, so their calldata cannot be decoded and
  // the creator's declared intent is simply unknown. Folding that into "bought nothing" and
  // "exempted nobody" would poison the two strongest signals, so absence is its own feature and
  // the derived flags only fire when the value was actually observed.
  // Amounts must be scaled by the quote asset's own decimals, not by 1e18. Nearly half of launches
  // are quoted in a token rather than ETH, and USDG uses six decimals where NVDA uses eighteen:
  // dividing both by 1e18 makes two economically identical self-buys differ by a factor of a
  // trillion, inside the feature the model leans on third-hardest.
  const dec = r.pair_token === ZERO_ADDR ? 18 : (r.quote_decimals ?? 18);
  const scale = 10 ** dec;
  const decoded = r.initial_buy_wei !== null;
  const buy = decoded ? Number(r.initial_buy_wei) / scale : 0;
  const threshold = Number(r.graduation_threshold_wei) / scale;

  const x = new Float64Array(FEATURES.length);
  let i = 0;
  x[i++] = decoded ? 1 : 0;
  x[i++] = r.exempt_count ?? 0;
  x[i++] = decoded && (r.exempt_count ?? 0) === 0 ? 1 : 0;
  x[i++] = decoded ? log1p(buy * 1000) : 0;
  x[i++] = decoded && buy === 0 ? 1 : 0;
  x[i++] = r.creator_tax_bps ?? 0;
  x[i++] = r.buyback_enabled ?? 0;
  x[i++] = socialVals.length;
  x[i++] = socials.twitter && socials.twitter.length > 3 ? 1 : 0;
  x[i++] = socials.website && socials.website.length > 3 ? 1 : 0;
  x[i++] = r.creator_fee_recipient && r.launch_sender && r.creator_fee_recipient !== r.launch_sender ? 1 : 0;
  x[i++] = r.launch_sender && r.launch_sender !== r.deployer ? 1 : 0;
  x[i++] = r.pair_token === ZERO_ADDR ? 1 : 0;
  x[i++] = log1p(threshold);
  x[i++] = Math.min(500, r.desc_len);
  x[i++] = r.symbol_len;
  x[i++] = h.priorL;
  x[i++] = h.priorG;
  x[i++] = h.priorL > 0 ? h.priorG / h.priorL : 0;
  x[i++] = h.priorL === 0 ? 1 : 0;
  x[i++] = h.overlap;
  x[i++] = new Date(r.ts * 1000).getUTCHours();
  x[i++] = h.recentCount;

  // A launch only counts as a settled negative once the horizon has elapsed; unresolved recent
  // launches are dropped by the caller via `ts`, so no right-censored row is mislabelled here.
  const label: 0 | 1 = r.grad_ts !== null && r.grad_ts - r.ts <= horizon ? 1 : 0;
  return { token: r.token, ts: r.ts, block: r.block, label, x };
}

const SPINE_SQL = `
  SELECT l.token, l.deployer, l.block, l.log_index, l.ts, g.ts AS grad_ts
  FROM launches l LEFT JOIN graduations g USING(token)`;

const DETAIL_COLUMNS = `
  l.token, l.deployer, l.launch_sender, l.pair_token, l.graduation_threshold_wei, l.block, l.ts,
  l.creator_fee_recipient, l.creator_tax_bps, l.buyback_enabled, l.initial_buy_wei,
  q.decimals AS quote_decimals,
  l.exempt_count, l.socials_json, g.ts AS grad_ts,
  coalesce(length(l.symbol), 0)      AS symbol_len,
  coalesce(length(l.description), 0) AS desc_len`;

const DETAIL_FROM = `
  FROM launches l LEFT JOIN graduations g USING(token)
  LEFT JOIN quote_assets q ON q.address = l.pair_token`;

/**
 * A build that can be carried forward instead of repeated.
 *
 * Rebuilding from scratch is a five-second pass over two hundred thousand launches, and the board
 * was doing it every fifteen seconds: on a single-threaded server that is a third of the time spent
 * refusing to answer anybody. Everything it computes about the past is immutable — a launch's
 * features come from history strictly earlier than itself — so the work only has to be done once,
 * and the arrival of new launches only has to be added.
 */
export type Cursor = {
  since: number;
  horizon: number;
  rows: Row[];
  devLaunches: Map<string, number>;
  devGraduations: Map<string, number>;
  seenExempt: Set<string>;
  recentLaunchTs: number[];
  recentHead: number;
  gradQueue: Array<{ ts: number; deployer: string }>;
  gradCursor: number;
  /** Graduations already queued, by token: a graduation is one per token, so this is exact. */
  gradSeen: Set<string>;
  lastBlock: number;
  lastLogIndex: number;
  /**
   * Launches inside the window that were walked before they had been enriched, holding the history
   * they must be scored against.
   *
   * A launch is written to the database when its log is read and enriched a second or two later, so
   * an incremental pass meets most of them in that gap. Advancing past one and forgetting it would
   * drop it from the board permanently — it would never appear, and nothing would report a fault.
   */
  pending: Map<string, { ts: number; history: History }>;
};

function exemptsFor(db: DB, tokens: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (tokens.length === 0) return out;
  const CHUNK = 400;
  for (let i = 0; i < tokens.length; i += CHUNK) {
    const part = tokens.slice(i, i + CHUNK);
    const rows = db.prepare(
      `SELECT token, address FROM exemptions WHERE token IN (${part.map(() => "?").join(",")})`,
    ).all(...part) as Array<{ token: string; address: string }>;
    for (const r of rows) {
      const list = out.get(r.token);
      if (list) list.push(r.address);
      else out.set(r.token, [r.address]);
    }
  }
  return out;
}

/**
 * Walks a batch of launches in order, advancing the history and emitting the rows that can be.
 *
 * The single place either build decides what a row is worth, so the incremental path cannot quietly
 * disagree with the full one about a creator's record.
 */
function walk(
  cur: Cursor,
  spine: Array<SpineRow & { log_index: number }>,
  detail: Map<string, LaunchRow>,
  exempts: Map<string, string[]>,
): Row[] {
  const emitted: Row[] = [];
  for (const sp of spine) {
    while (cur.gradCursor < cur.gradQueue.length && cur.gradQueue[cur.gradCursor].ts <= sp.ts) {
      const q = cur.gradQueue[cur.gradCursor];
      cur.devGraduations.set(q.deployer, (cur.devGraduations.get(q.deployer) ?? 0) + 1);
      cur.gradCursor++;
    }
    while (cur.recentHead < cur.recentLaunchTs.length && cur.recentLaunchTs[cur.recentHead] < sp.ts - 3600) cur.recentHead++;

    const priorL = cur.devLaunches.get(sp.deployer) ?? 0;
    const priorG = cur.devGraduations.get(sp.deployer) ?? 0;
    // Exemptions are the one piece of history that does need enrichment, since they are read out of
    // the launch calldata. That makes `exempt_seen_before` a partial count where coverage is
    // partial, unlike the creator counters above, which are exact.
    const own = exempts.get(sp.token) ?? [];

    if (sp.ts >= cur.since) {
      const history: History = {
        priorL,
        priorG,
        overlap: own.filter((a) => cur.seenExempt.has(a)).length,
        recentCount: cur.recentLaunchTs.length - cur.recentHead,
      };
      const r = detail.get(sp.token);
      if (r) emitted.push(featureRow(r, history, cur.horizon));
      else cur.pending.set(sp.token, { ts: sp.ts, history });
    }

    cur.devLaunches.set(sp.deployer, priorL + 1);
    for (const a of own) cur.seenExempt.add(a);
    cur.recentLaunchTs.push(sp.ts);
    cur.lastBlock = sp.block;
    cur.lastLogIndex = sp.log_index;
  }
  return emitted;
}

/** A cursor over every launch, with rows for those inside the window. */
export function openCursor(db: DB, since: number, horizon = 4 * 3600): Cursor {
  const cur: Cursor = {
    since, horizon, rows: [],
    devLaunches: new Map(), devGraduations: new Map(), seenExempt: new Set(),
    recentLaunchTs: [], recentHead: 0,
    gradQueue: [], gradCursor: 0, gradSeen: new Set(),
    lastBlock: -1, lastLogIndex: -1,
    pending: new Map(),
  };

  // Graduations become visible history only once they happen, so they are applied on a time queue.
  // A creator's earlier launch can graduate after the launch being scored, and crediting it by the
  // earlier launch's own timestamp would be reading the future.
  for (const g of db.prepare(`
    SELECT g.token, g.ts, l.deployer FROM graduations g JOIN launches l USING(token)
    ORDER BY g.ts ASC`).all() as Array<{ token: string; ts: number; deployer: string }>) {
    cur.gradQueue.push({ ts: g.ts, deployer: g.deployer });
    cur.gradSeen.add(g.token);
  }

  const spine = db.prepare(`${SPINE_SQL} ORDER BY l.block ASC, l.log_index ASC`).all() as
    Array<SpineRow & { log_index: number }>;

  const detail = new Map<string, LaunchRow>();
  for (const d of db.prepare(`
    SELECT ${DETAIL_COLUMNS} ${DETAIL_FROM}
    WHERE l.enriched_at IS NOT NULL AND l.ts >= ?
    ORDER BY l.block ASC, l.log_index ASC`).all(since) as LaunchRow[]) detail.set(d.token, d);

  const exempts = new Map<string, string[]>();
  for (const r of db.prepare("SELECT token, address FROM exemptions").all() as Array<{ token: string; address: string }>) {
    const list = exempts.get(r.token);
    if (list) list.push(r.address);
    else exempts.set(r.token, [r.address]);
  }

  cur.rows = walk(cur, spine, detail, exempts);
  return cur;
}

/**
 * Brings a cursor up to date, in milliseconds rather than seconds.
 *
 * Returns false when it cannot: asking for a window wider than the one it was opened on needs
 * history it discarded, so the caller opens a new cursor instead of being handed a short answer.
 */
export function advanceCursor(db: DB, cur: Cursor, since: number): boolean {
  if (since < cur.since) return false;
  cur.since = since;

  // Graduations that landed since the last pass, including for launches walked long ago. Appending
  // keeps the queue sorted, because a graduation cannot be older than one already seen.
  const fresh = db.prepare(`
    SELECT g.token, g.ts, l.deployer FROM graduations g JOIN launches l USING(token)
    WHERE g.ts >= ? ORDER BY g.ts ASC`).all(cur.gradQueue.length ? cur.gradQueue[cur.gradQueue.length - 1].ts : 0) as
    Array<{ token: string; ts: number; deployer: string }>;
  for (const g of fresh) {
    if (cur.gradSeen.has(g.token)) continue;
    cur.gradQueue.push({ ts: g.ts, deployer: g.deployer });
    cur.gradSeen.add(g.token);
  }

  const spine = db.prepare(`
    ${SPINE_SQL}
    WHERE (l.block > ?) OR (l.block = ? AND l.log_index > ?)
    ORDER BY l.block ASC, l.log_index ASC`).all(cur.lastBlock, cur.lastBlock, cur.lastLogIndex) as
    Array<SpineRow & { log_index: number }>;

  const wanted = spine.filter((s) => s.ts >= since).map((s) => s.token).concat([...cur.pending.keys()]);
  const detail = new Map<string, LaunchRow>();
  if (wanted.length) {
    const CHUNK = 400;
    for (let i = 0; i < wanted.length; i += CHUNK) {
      const part = wanted.slice(i, i + CHUNK);
      for (const d of db.prepare(`
        SELECT ${DETAIL_COLUMNS} ${DETAIL_FROM}
        WHERE l.enriched_at IS NOT NULL AND l.token IN (${part.map(() => "?").join(",")})`).all(...part) as LaunchRow[]) {
        detail.set(d.token, d);
      }
    }
  }

  const emitted = walk(cur, spine, detail, exemptsFor(db, spine.map((s) => s.token)));

  // Launches met before they were enriched, now readable. Their features use the history recorded
  // where they actually sit in the order, not today's.
  for (const [token, held] of [...cur.pending]) {
    if (held.ts < since) { cur.pending.delete(token); continue; }
    const r = detail.get(token);
    if (!r) continue;
    emitted.push(featureRow(r, held.history, cur.horizon));
    cur.pending.delete(token);
  }

  if (emitted.length) {
    cur.rows = cur.rows.concat(emitted);
    cur.rows.sort((a, b) => a.block - b.block || a.ts - b.ts);
  }
  if (cur.rows.length && cur.rows[0].ts < since) cur.rows = cur.rows.filter((r) => r.ts >= since);
  return true;
}

/**
 * Builds the training matrix in block order, carrying per-creator state forward as it goes so every
 * row sees only its own past. Returns rows sorted by time, which is what the temporal split needs.
 *
 * `since` limits which launches become rows, not which are walked: history has to be accumulated
 * over every launch or a creator's record would start at the window edge.
 */
export function buildDataset(db: DB, opts: { labelHorizonSec?: number; since?: number } = {}): Row[] {
  return openCursor(db, opts.since ?? 0, opts.labelHorizonSec ?? 4 * 3600).rows;
}

/**
 * Drops rows whose outcome is not yet settled. A launch from ten minutes ago has not graduated
 * *yet*, which is not the same as not graduating: training on it as a negative teaches the model
 * that recent launches fail.
 */
export function dropCensored(rows: Row[], nowTs: number, horizonSec = 4 * 3600): Row[] {
  return rows.filter((r) => r.label === 1 || r.ts + horizonSec <= nowTs);
}
