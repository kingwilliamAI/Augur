import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildCard } from "./card.ts";
import { dataset, datasetAgeSec, datasetCachedOnly, datasetVersion, FEATURES, loadModel, scoreOne, scoreRecent, type FeedOrder } from "./score.ts";
import { getMeta, openDb } from "./db.ts";
import { contributions, type GbdtModel } from "./model/gbdt.ts";
import { grade, modelId, pending, score as scoreLog, settled } from "./track.ts";
import { formatUnits, quoteFromCache } from "./quote.ts";
import { formatUsd, marketCapUsd, usdOf } from "./prices.ts";
import { BLOCKS_PER_DAY } from "./config.ts";
import { CFG } from "./config.ts";
import { indexCurve } from "./curve.ts";
import { graduationCapUsd, poolCaps, quotePerToken } from "./pool.ts";
import { logsClient, sleep, stateClient, withRetry } from "./chain.ts";

const here = dirname(fileURLToPath(import.meta.url));
const db = openDb();
let model = loadModel();
/** Tokens whose curve is being read right now, so two opens of one card cost one read. */
const indexing = new Set<string>();

const SEC_PER_BLOCK = 86400 / BLOCKS_PER_DAY;

/**
 * Answers held while the matrix they came from is unchanged.
 *
 * Small on purpose and cleared wholesale: entries are keyed on a build of the matrix that has
 * already been replaced, so once it turns over none of them can be hit again.
 */
const feedCache = new Map<string, string>();
/**
 * The finished bytes, not the object they came from.
 *
 * The feed is 180 KB, and turning the object into that is the largest thing left on a held answer:
 * paid once here, it would otherwise be paid again for every reader who receives the identical
 * body.
 */
function holdFeed(key: string, value: unknown): string {
  const body = JSON.stringify(value);
  if (feedCache.size > 64) feedCache.clear();
  feedCache.set(key, body);
  return body;
}

function sendJson(res: import("node:http").ServerResponse, body: string): void {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

type Influence = Array<{ name: string; value: number }>;

/**
 * Feature influence, computed off the hot path and served while the next one is being made.
 *
 * Weighing three thousand launches is a second and a quarter, and on a single thread that second is
 * every other request too — a stall the whole site takes, once per cache expiry, so that one page
 * can show a figure that moves over days. It is now done two hundred rows at a time, yielding
 * between slices, so nothing waits longer than a slice; the previous answer is served meanwhile.
 *
 * Ten minutes rather than one, for the same reason: the panel is honest at that age, and the work
 * is not worth repeating sooner.
 */
const INFLUENCE_TTL_MS = 10 * 60_000;
const INFLUENCE_SLICE = 200;
let importanceCache: { id: string; at: number; value: Influence } | null = null;
let importanceRunning = false;

async function computeInfluence(db: DB, model: GbdtModel): Promise<Influence> {
  const rows = (datasetCachedOnly() ?? dataset(db, Math.floor(Date.now() / 1000) - 6 * 3600)).slice(-3000);
  const acc = new Float64Array(FEATURES.length);
  for (let i = 0; i < rows.length; i += INFLUENCE_SLICE) {
    const end = Math.min(i + INFLUENCE_SLICE, rows.length);
    for (let k = i; k < end; k++) {
      const { contribs } = contributions(model, rows[k].x);
      for (let f = 0; f < acc.length; f++) acc[f] += Math.abs(contribs[f]);
    }
    // Hand the loop back so a request waiting behind this is answered between slices.
    await new Promise((r) => setImmediate(r));
  }
  return FEATURES.map((name, i) => ({ name, value: rows.length ? acc[i] / rows.length : 0 }))
    .sort((a, b) => b.value - a.value)
    .filter((f) => f.value > 0.0005);
}

/**
 * How far behind the chain the data is, and how long since the watcher last said anything.
 *
 * A watcher that has died and a chain that has simply gone quiet look identical from the outside:
 * the list stops changing either way. Serving this makes the difference visible, which is the whole
 * point — a scanner that silently freezes is worse than one that says it is stuck, because the first
 * one still looks right.
 */
function health(): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const head = Number(getMeta(db, "live_head_block") ?? 0);
  const seenAt = Number(getMeta(db, "live_seen_at") ?? 0);
  const done = (db.prepare("SELECT coalesce(max(block), 0) b FROM launches").get() as { b: number }).b;

  const behindBlocks = head && done ? Math.max(0, head - done) : null;
  return {
    watcherSeenSecAgo: seenAt ? now - seenAt : null,
    behindBlocks,
    behindSec: behindBlocks === null ? null : Math.round(behindBlocks * SEC_PER_BLOCK),
    feedAgeSec: datasetAgeSec(),
    headBlock: head || null,
    indexedBlock: done || null,
  };
}

/**
 * Requests a minute per address, counted in fixed windows.
 *
 * Crude on purpose: the feed is a public read of data anyone could gather themselves, so this exists
 * to stop one script making the board useless for everyone, not to guard a secret.
 *
 * Sixty was too tight to be that, and caught readers rather than scripts. One open page polls the
 * feed twelve times a minute on its own, and opening a launch costs the card plus up to two follow
 * ups while its curves are still being read, so someone clicking through a dozen launches crossed
 * the line in under a minute of ordinary use. What they got for it was worse than a refusal: the
 * page read the rejection as an answer and reported the watcher as dead. Four a second still bounds
 * a scraper and leaves a person alone.
 */
const RATE_LIMIT = Number(process.env.RATE_LIMIT ?? 240);
const RATE_WINDOW_MS = 60_000;
const hits = new Map<string, { n: number; until: number }>();
/** Only believe a forwarded address when this instance is knowingly behind a proxy. */
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

function overLimit(req: import("node:http").IncomingMessage): boolean {
  const fwd = TRUST_PROXY ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
  const who = fwd || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const seen = hits.get(who);
  if (!seen || now > seen.until) {
    if (hits.size > 10_000) hits.clear(); // bounded: an expired window costs nothing to forget
    hits.set(who, { n: 1, until: now + RATE_WINDOW_MS });
    return false;
  }
  seen.n++;
  return seen.n > RATE_LIMIT;
}

/**
 * Per-window aggregates for the feed, cached briefly.
 *
 * Measured on a six-hour window over 170,000 launches: the creator totals cost 678 ms and the ticker
 * clusters 140 ms, against 62 ms for scoring every row on the board. They were being recomputed on
 * every poll, and because node:sqlite is synchronous that time is not just the feed's — it is the
 * whole server's, so opening a card queued behind a number that had not meaningfully changed.
 *
 * A cluster size and a creator's launch count barely move in half a minute, and the feed is a live
 * view where a thirty-second-old count reads identically. Freshness that matters — the launches
 * themselves, their scores, the staleness banner — is not cached here.
 */
const AGG_TTL_MS = 30_000;
type Aggregates = {
  clusters: Map<string, { n: number; g: number }>;
  devTotal: Map<string, number>;
  devBest: Map<string, Array<{ usd: number; symbol: string | null; token: string }>>;
  counts: { launches: number; graduations: number; enriched: number };
};
let aggCache: { at: number; since: number; v: Aggregates } | null = null;

function aggregates(rawSince: number): Aggregates {
  // The window start moves every second, so it is bucketed to the minute; otherwise the key never
  // matches its own previous value and the cache can never hit.
  const since = Math.floor(rawSince / 60) * 60;
  if (aggCache && aggCache.since === since && Date.now() - aggCache.at < AGG_TTL_MS) return aggCache.v;

  const clusters = new Map<string, { n: number; g: number }>();
  for (const r of db.prepare(`
    SELECT l.symbol_key k, count(*) n, sum(g.token IS NOT NULL) g
    FROM launches l LEFT JOIN graduations g ON g.token = l.token
    WHERE l.symbol_key IN (SELECT DISTINCT symbol_key FROM launches WHERE ts >= ? AND symbol_key IS NOT NULL)
    GROUP BY l.symbol_key`).all(since) as Array<{ k: string; n: number; g: number | null }>) {
    clusters.set(r.k, { n: r.n, g: r.g ?? 0 });
  }

  // Total launches per creator, not launches before this one. The row only needs this to answer
  // "has this wallet launched more than once" for the repeat-creators filter; the card computes the
  // exact prior-only history, which is what the score is allowed to see.
  const devTotal = new Map<string, number>();
  for (const r of db.prepare(`
    SELECT deployer d, count(*) n FROM launches
    WHERE deployer IN (SELECT DISTINCT deployer FROM launches WHERE ts >= ?)
    GROUP BY deployer`).all(since) as Array<{ d: string; n: number }>) {
    devTotal.set(r.d, r.n);
  }

  /**
   * The highest any of a creator's launches has ever reached, in dollars.
   *
   * Put on the row rather than left inside the card, because it is the one fact about a fresh launch
   * that is already settled: the launch itself has no history yet, its creator does. A wallet whose
   * best of sixty-four attempts was six thousand dollars is saying something the score cannot.
   *
   * Built from what has a peak rather than from every launch, which is a much smaller set: read
   * curves, folded summaries, and pools. Measured at 485 ms plus 123 ms over the six-hour window,
   * which is why it sits behind the same thirty-second cache as the other totals; a creator's record
   * does not move within half a minute.
   */
  /**
   * The two best, not the one best.
   *
   * The column promises the highest an *earlier* launch by this creator reached, and a row must not
   * be allowed to answer with itself. A creator whose only launch is the row you are looking at was
   * reporting that launch's own peak as their track record: the board said $1.2M beside a card that
   * said "first launch from this wallet". Keeping the runner-up costs nothing and lets a row skip
   * past itself.
   */
  type Peaked = { usd: number; symbol: string | null; token: string };
  const devBest = new Map<string, Peaked[]>();
  const consider = (dev: string, usd: number | null, symbol: string | null, token: string): void => {
    if (usd === null || !Number.isFinite(usd)) return;
    const list = devBest.get(dev) ?? [];
    list.push({ usd, symbol, token });
    list.sort((a, b) => b.usd - a.usd);
    devBest.set(dev, list.slice(0, 2));
  };

  for (const r of db.prepare(`
    WITH peaked AS (
      SELECT token, peak_price peak FROM curve_summary
      UNION ALL
      SELECT token, max(CAST(quote_wei AS REAL) / CAST(token_amt AS REAL)) peak
      FROM curve_trades WHERE CAST(token_amt AS REAL) > 0 GROUP BY token
    )
    SELECT l.deployer, l.token, l.symbol, l.pair_token, p.peak
    FROM peaked p JOIN launches l ON l.token = p.token
    WHERE l.deployer IN (SELECT deployer FROM launches WHERE ts >= ?)`).all(since) as
    Array<{ deployer: string; token: string; symbol: string | null; pair_token: string; peak: number }>) {
    const q = quoteFromCache(db, r.pair_token);
    // Raw quote units per token unit, lifted to whole units on both sides.
    consider(r.deployer, marketCapUsd(r.peak * (1e18 / 10 ** q.decimals), q.symbol), r.symbol, r.token);
  }

  // A graduated token's curve high is the bar it had to clear, so the pool has to be allowed to
  // answer for it; this is the same rule the card applies.
  for (const r of db.prepare(`
    SELECT l.deployer, l.token, l.symbol, l.pair_token, k.min_sqrt, k.max_sqrt, p.token_is_c1, p.dec0, p.dec1
    FROM pool_peaks k JOIN pools p ON p.pool_id = k.pool_id JOIN launches l ON l.token = p.token
    WHERE l.deployer IN (SELECT deployer FROM launches WHERE ts >= ?)`).all(since) as
    Array<{ deployer: string; token: string; symbol: string | null; pair_token: string;
            min_sqrt: string; max_sqrt: string; token_is_c1: number; dec0: number; dec1: number }>) {
    const q = quoteFromCache(db, r.pair_token);
    const sqrt = r.token_is_c1 ? r.min_sqrt : r.max_sqrt;
    consider(r.deployer, marketCapUsd(quotePerToken(sqrt, r), q.symbol), r.symbol, r.token);
  }

  const counts = db.prepare(`
    SELECT (SELECT count(*) FROM launches) launches,
           (SELECT count(*) FROM graduations) graduations,
           (SELECT count(*) FROM launches WHERE enriched_at IS NOT NULL) enriched`).get() as Aggregates["counts"];

  const v: Aggregates = { clusters, devTotal, devBest, counts };
  aggCache = { at: Date.now(), since, v };
  return v;
}

/**
 * The headline figures on the front page, measured from this database rather than typed in. Cached
 * for a minute: they move slowly and the median needs a sort.
 */
let statsCache: { at: number; body: Record<string, unknown> } | null = null;
function stats(): Record<string, unknown> {
  if (statsCache && Date.now() - statsCache.at < 60_000) return statsCache.body;
  const now = Math.floor(Date.now() / 1000);
  const week = now - 7 * 86400;
  const c = db.prepare(`
    SELECT (SELECT count(*) FROM launches WHERE ts >= ?) launches,
           (SELECT count(*) FROM graduations WHERE ts >= ?) graduations,
           (SELECT count(*) FROM launches WHERE ts >= ?) launches24h,
           (SELECT count(*) FROM launches) total,
           (SELECT count(*) FROM launches WHERE enriched_at IS NOT NULL) enriched`,
  ).get(week, week, now - 86400) as Record<string, number>;
  const secs = (db.prepare(`
    SELECT g.ts - l.ts s FROM graduations g JOIN launches l USING(token) WHERE l.ts >= ? AND g.ts >= l.ts ORDER BY s`,
  ).all(week) as Array<{ s: number }>).map((r) => r.s);
  const validation = JSON.parse(getMeta(db, "validation_json") ?? "null");
  const body = {
    baseRate: c.launches ? c.graduations / c.launches : null,
    medianSecToGraduate: secs.length ? secs[Math.floor(secs.length / 2)] : null,
    launches24h: c.launches24h,
    launchesWeek: c.launches,
    graduationsWeek: c.graduations,
    total: c.total,
    enriched: c.enriched,
    decileLift: validation?.decile?.mean ?? null,
    validatedAt: validation?.at ?? null,
  };
  statsCache = { at: Date.now(), body };
  return body;
}

/**
 * Reads the curves of a creator's earlier launches, in the background, a few at a time.
 *
 * A peak is only knowable from that token's own trades, and those live on its own curve address, so
 * "what is the best this creator ever did" costs one read per earlier launch. A creator with fifty
 * of them would hold a card open for half a minute, which is not a trade worth making: the card
 * answers now with the peaks already known and says how many it has not read, and the rest arrive
 * before the next time anyone looks at this creator.
 */
const CREATOR_PEAKS_PER_OPEN = 6;

/**
 * The chain head, retried, from the endpoint that is generous about being asked.
 *
 * Every background read here starts by asking how high the chain is. Asking the log endpoint without
 * a retry meant one 429 threw, the enclosing catch swallowed it, and the whole backfill silently did
 * nothing — a creator with sixty-five launches sat at zero curves read while the card politely said
 * it was still reading them.
 */
async function chainHead(): Promise<number> {
  try {
    return Number(await withRetry(() => stateClient.getBlockNumber()));
  } catch {
    return Number(await withRetry(() => logsClient.getBlockNumber()));
  }
}

async function backfillCreatorPeaks(token: string): Promise<void> {
  const rows = db.prepare(`
    SELECT x.token, x.curve, x.block FROM launches x
    WHERE x.deployer = (SELECT deployer FROM launches WHERE token = ?)
      AND x.token != ?
      AND x.token NOT IN (SELECT token FROM curve_indexed)
    ORDER BY x.block DESC LIMIT ?`).all(token, token, CREATOR_PEAKS_PER_OPEN) as
    Array<{ token: string; curve: string; block: number }>;
  if (!rows.length) return;

  let head: number;
  try {
    head = await chainHead();
  } catch {
    return; // genuinely unreachable right now; the next card open tries again
  }

  for (const r of rows) {
    if (indexing.has(r.token)) continue;
    indexing.add(r.token);
    try {
      await indexCurve(db, r.token, r.curve, r.block, Math.min(head, r.block + 900_000));
    } catch {
      // One unreadable curve must not stop the rest.
    } finally {
      indexing.delete(r.token);
    }
  }
}

const json = (res: import("node:http").ServerResponse, body: unknown, code = 200): void => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(s) });
  res.end(s);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${CFG.boardPort}`);

  if (url.pathname.startsWith("/api/") && overLimit(req)) {
    json(res, { error: "rate limited", limit: `${RATE_LIMIT}/min` }, 429);
    return;
  }

  if (url.pathname === "/api/health") { json(res, health()); return; }

  if (url.pathname === "/api/stats") { json(res, stats()); return; }

  if (url.pathname === "/api/model") {
    model = loadModel();
    const path = "./data/model.json";
    const id = modelId(path);
    const trainedAt = existsSync(path) ? Math.floor(statSync(path).mtimeMs / 1000) : null;

    const usable = importanceCache && importanceCache.id === id ? importanceCache.value : null;
    const fresh = usable !== null && Date.now() - (importanceCache as { at: number }).at < INFLUENCE_TTL_MS;
    if (model && !fresh && !importanceRunning) {
      importanceRunning = true;
      const work = computeInfluence(db, model)
        .then((value) => { importanceCache = { id, at: Date.now(), value }; })
        .catch(() => { /* a failed pass leaves the previous answer standing */ })
        .finally(() => { importanceRunning = false; });
      // Only the very first caller after a restart waits; everyone else gets the last answer.
      if (!usable) await work;
    }
    const importance: Influence = (importanceCache && importanceCache.id === id ? importanceCache.value : null) ?? [];

    // Two kinds of evidence, kept apart on purpose. Validation is retrospective and comes from
    // `npm run validate`; the live log is claims written before their outcome existed, graded by
    // the chain. They answer different questions and must never be averaged together.
    const validation = JSON.parse(getMeta(db, "validation_json") ?? "null");
    grade(db);
    const thisModel = settled(db, id);
    const everything = settled(db);
    const toRows = (xs: typeof thisModel) => xs.map((r) => ({ probability: r.probability, label: r.label as 0 | 1 }));
    json(res, {
      modelId: id,
      trainedAt,
      featureCount: FEATURES.length,
      importance,
      validation,
      live: {
        thisModel: { n: thisModel.length, score: scoreLog(toRows(thisModel)) },
        allModels: { n: everything.length, score: scoreLog(toRows(everything)) },
        pending: pending(db),
      },
    });
    return;
  }

  /**
   * The project mark, if one has been dropped in.
   *
   * Optional on purpose: the repository ships without a logo, and a missing file is a 404 the page
   * handles by falling back to the plain lime square rather than a broken image.
   */
  /**
   * The mark and the favicons cut from it by `npm run icon`.
   *
   * All optional: the repository can ship without a mark, and a missing file is a 404 the page
   * handles by falling back to the plain lime square rather than a broken image. The small ones are
   * cached hard because they change only when somebody replaces the logo, and every visitor fetches
   * one before the page has finished drawing.
   */
  const ASSETS: Record<string, string> = {
    "/logo.png": "logo.png",
    "/icon-128.png": "icon-128.png",
    "/icon-64.png": "icon-64.png",
  };
  const asset = ASSETS[url.pathname];
  if (asset) {
    const file = join(here, "ui", asset);
    if (!existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=86400" });
    res.end(readFileSync(file));
    return;
  }

  if (url.pathname === "/og.png") {
    const file = [join(here, "ui", "og.png"), join(here, "ui", "logo.png")].find((f) => existsSync(f));
    if (!file) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=3600" });
    res.end(readFileSync(file));
    return;
  }

  if (url.pathname === "/") {
    const html = readFileSync(join(here, "ui", "index.html"));
    // Re-read per request so an edit shows up on reload — which only works if the browser is told
    // not to keep its own copy. With no cache header at all it caches heuristically and serves a
    // stale page against a live API, which reads as the data being wrong rather than the page.
    // Absolute URLs, because a preview is fetched by someone else's server and a relative path
    // means nothing to it. Taken from the request rather than configured, so the same build gives
    // the right links behind the proxy, on a tunnel, and on localhost without being told where it is.
    const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim()
      || (TRUST_PROXY ? "https" : "http");
    const base = `${proto}://${req.headers.host ?? `localhost:${CFG.boardPort}`}`;
    // A square mark centre-crops badly in a wide card, so ask for the small one until a purpose-made
    // image exists.
    const wide = existsSync(join(here, "ui", "og.png"));
    const page = String(html)
      .replaceAll("__BASE__", base)
      .replaceAll("__TWITTER_CARD__", wide ? "summary_large_image" : "summary");

    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(page);
    return;
  }

  /**
   * The coin the site is about, read from the chain like any other launch.
   *
   * Everything here comes from the same tables every other card uses, so the page cannot claim
   * anything the board could not also show about somebody else's token. What it deliberately does
   * not carry is holders, liquidity or a 24-hour volume: none of those are indexed, and inventing
   * them on the one page people would check before buying is the last place to start guessing.
   */
  if (url.pathname === "/api/coin") {
    const tok = CFG.coinToken;
    if (!tok) { json(res, { configured: false }); return; }

    const l = db.prepare("SELECT * FROM launches WHERE token = ?").get(tok) as Record<string, unknown> | undefined;
    if (!l) { json(res, { configured: true, found: false, token: tok }); return; }

    const q = quoteFromCache(db, String(l.pair_token));
    const g = db.prepare("SELECT tx, ts FROM graduations WHERE token = ?").get(tok) as
      | { tx: string; ts: number } | undefined;
    const caps = poolCaps(db, tok, q.symbol);
    const dec = Number(q.decimals);

    json(res, {
      configured: true,
      found: true,
      standIn: !CFG.coinIsOurs,
      token: tok,
      symbol: (l.symbol as string | null) ?? null,
      name: (l.name as string | null) ?? null,
      launchTs: Number(l.ts),
      launchTx: String(l.tx),
      creator: (l.launch_sender as string | null) ?? String(l.deployer),
      feeRecipient: (l.creator_fee_recipient as string | null) ?? null,
      creatorTaxBps: l.creator_tax_bps === null ? null : Number(l.creator_tax_bps),
      selfBuy: l.initial_buy_wei === null ? null : formatUnits(BigInt(l.initial_buy_wei as string), dec),
      exemptCount: Number(l.exempt_count ?? 0),
      quoteSymbol: q.symbol,
      threshold: l.graduation_threshold_wei === null
        ? null : formatUnits(BigInt(l.graduation_threshold_wei as string), dec),
      /**
       * The graduation bar as a market cap, beside the reserve that has to flow in to clear it.
       *
       * Showing only "4.2 ETH" invited exactly the wrong reading: it looks like the valuation a
       * launch graduates at, and it is not. The reserve is about $10.6K of ETH; the cap it implies
       * is $51.9K, because a cap is the price per token times the supply. Measured per quote asset
       * rather than globally, since ETH graduates at $51.9K and TTWO at $28.0K.
       */
      gradCapUsd: (() => {
        const c = graduationCapUsd(
          db, (pt) => quoteFromCache(db, pt).decimals, (pt) => quoteFromCache(db, pt).symbol, q.symbol,
        );
        return c === null ? null : formatUsd(c);
      })(),
      x: CFG.coinX || null,
      repo: CFG.coinRepo || null,
      graduated: Boolean(g),
      graduationTx: g?.tx ?? null,
      secondsToGraduate: g ? g.ts - Number(l.ts) : null,
      supply: 1_000_000_000,
      // Dexscreener addresses a pons market by its pool id, not by the token: confirmed against
      // their own API, which returns chainId "robinhood" and that url for this token.
      poolId: (db.prepare("SELECT pool_id FROM pools WHERE token = ?").get(tok) as { pool_id: string } | undefined)?.pool_id ?? null,
      pool: caps === null ? null : {
        openUsd: caps.openUsd, peakUsd: caps.peakUsd, lastUsd: caps.lastUsd, swaps: caps.swaps,
      },
      /**
       * The price path along the curve, in dollars of market cap.
       *
       * Every curve trade records what was paid and what came back, so a price falls out of each log
       * exactly. This covers the opening act, up to the moment the token left the curve.
       */
      curve: (() => {
        const rows = db.prepare(
          "SELECT quote_wei, token_amt, block FROM curve_trades WHERE token = ? ORDER BY block, log_index",
        ).all(tok) as Array<{ quote_wei: string; token_amt: string; block: number }>;
        const pts: Array<{ b: number; usd: number }> = [];
        for (const r of rows) {
          const tokens = Number(r.token_amt);
          if (!(tokens > 0)) continue;
          const cap = marketCapUsd((Number(r.quote_wei) / tokens) * (1e18 / 10 ** dec), q.symbol);
          if (cap !== null && Number.isFinite(cap) && cap > 0) pts.push({ b: r.block, usd: cap });
        }
        return pts.length > 240 ? pts.filter((_, i) => i % Math.ceil(pts.length / 240) === 0) : pts;
      })(),

      /**
       * What the creator has actually earned, read from the hook's sweeps.
       *
       * Not from the swaps: the pool's own fee is zero on every one of them, because pons accrues in
       * its hook and sweeps periodically. Checkable against the token's public pons page, which is
       * how the event was identified in the first place.
       */
      fees: (() => {
        const pr = db.prepare("SELECT pool_id FROM pools WHERE token = ?").get(tok) as { pool_id: string } | undefined;
        if (!pr) return null;
        const all = db.prepare(
          "SELECT count(*) n, coalesce(sum(CAST(fee_quote AS REAL)), 0) s FROM coin_sweeps WHERE pool_id = ?",
        ).get(pr.pool_id) as { n: number; s: number };
        if (!all.n) return null;
        const usdPer = usdOf(q.symbol);
        const toQuote = (raw: number) => raw / 10 ** dec;
        const recent = db.prepare(
          "SELECT block, fee_quote FROM coin_sweeps WHERE pool_id = ? ORDER BY block DESC LIMIT 6",
        ).all(pr.pool_id) as Array<{ block: number; fee_quote: string }>;
        return {
          sweeps: all.n,
          quote: toQuote(all.s),
          usd: usdPer === null ? null : toQuote(all.s) * usdPer,
          recent: recent.map((r) => ({
            block: r.block,
            quote: toQuote(Number(r.fee_quote)),
            usd: usdPer === null ? null : toQuote(Number(r.fee_quote)) * usdPer,
          })),
        };
      })(),

      /**
       * The same thing after graduation, from the pool.
       *
       * These come from `coin_bars`, which exists only for this one coin: folding the whole swap
       * stream to a high and a low is the only affordable shape for four thousand pools, and the
       * wrong one for the single pool a page is about. Volume and fees ride along because the Swap
       * event carries both amounts and the pool's fee rate, which the chain-wide pass discards.
       */
      pool2: (() => {
        const pr = db.prepare("SELECT pool_id, token_is_c1, dec0, dec1 FROM pools WHERE token = ?").get(tok) as
          | { pool_id: string; token_is_c1: number; dec0: number; dec1: number } | undefined;
        if (!pr) return null;
        const bars = db.prepare(
          "SELECT bucket, close_sqrt, hi_sqrt, lo_sqrt, swaps, vol_quote, fee_quote, last_block FROM coin_bars WHERE pool_id = ? ORDER BY bucket",
        ).all(pr.pool_id) as Array<{
          bucket: number; close_sqrt: string; hi_sqrt: string; lo_sqrt: string;
          swaps: number; vol_quote: string; fee_quote: string; last_block: number;
        }>;
        if (!bars.length) return null;

        const scale = 1 / 10 ** dec;
        const usdPer = usdOf(q.symbol);
        const series = bars.map((b) => ({
          b: b.last_block,
          usd: marketCapUsd(quotePerToken(b.close_sqrt, pr), q.symbol),
        })).filter((p) => p.usd !== null && Number.isFinite(p.usd as number));

        // A day of chain, in blocks, so "last 24h" is measured rather than assumed from row count.
        const dayFrom = bars[bars.length - 1].last_block - BLOCKS_PER_DAY;
        const recent = bars.filter((b) => b.last_block >= dayFrom);
        const sum = (rows: typeof bars, f: (b: typeof bars[number]) => number) => rows.reduce((a, b) => a + f(b), 0);
        const toUsd = (raw: number) => (usdPer === null ? null : raw * scale * usdPer);

        // A six-hour window, which is only answerable because this coin keeps bars. Quoting a change
        // "since the pool opened" was the honest thing to say when there was no series; there is one
        // now, and six hours is what a reader of a price actually wants.
        const last = series.length ? series[series.length - 1] : null;
        const sixFrom = bars[bars.length - 1].last_block - Math.round(BLOCKS_PER_DAY / 4);
        const older = series.find((s) => s.b >= sixFrom) ?? series[0];
        const change6h = last && older && older.usd
          ? { pct: ((last.usd as number) / (older.usd as number) - 1) * 100, from: older.usd as number }
          : null;

        // Uniswap's tick, from the price rather than from storage: the pool quotes 1.0001^tick, so
        // the log recovers it without keeping another column.
        const px = quotePerToken(bars[bars.length - 1].close_sqrt, pr);
        const tick = px > 0 ? Math.round(Math.log(px) / Math.log(1.0001)) : null;

        return {
          bars: series,
          swapsAll: sum(bars, (b) => b.swaps),
          swaps24h: sum(recent, (b) => b.swaps),
          vol24hUsd: toUsd(sum(recent, (b) => Number(b.vol_quote))),
          volAllUsd: toUsd(sum(bars, (b) => Number(b.vol_quote))),
          change6h,
          tick,
          coveredTo: bars[bars.length - 1].last_block,
        };
      })(),
    });
    return;
  }

  if (url.pathname === "/api/feed") {
    // Reloaded per request so a nightly retrain is picked up without restarting the board.
    model = loadModel();
    /**
     * The same answer, not a stale one.
     *
     * Ranking the window is two thirds of a second of CPU, and every open tab asks for it every
     * fifteen seconds. Five tabs on the same settings had the server computing an identical answer
     * five times, and on a single thread the fifth reader waits for all four. The key carries the
     * build of the matrix, so a held answer is only ever served while the rows behind it are the
     * rows it was made from; the moment the cursor advances, the key changes with it.
     */
    const feedKey = `${datasetVersion()}:${modelId()}:${url.searchParams.get("hours") ?? 6}:` +
      `${url.searchParams.get("sort") ?? "score"}:${url.searchParams.get("min") ?? 0}`;
    const held = feedCache.get(feedKey);
    if (held) { sendJson(res, held); return; }
    const hours = Number(url.searchParams.get("hours") ?? 6);
    const order: FeedOrder = url.searchParams.get("sort") === "new" ? "new" : "score";
    // The reader's floor, as a probability. Clamped rather than trusted: a threshold at or above 1
    // would empty the board and read as the feed being broken.
    const minP = Math.min(0.99, Math.max(0, Number(url.searchParams.get("min") ?? 0) || 0));
    const page = model ? scoreRecent(db, model, hours, 150, order, minP) : null;
    const rows = page?.items ?? [];
    const now = Math.floor(Date.now() / 1000);
    const since = now - hours * 3600;

    /**
     * Three cheap queries instead of one expensive one.
     *
     * This used to be a single SELECT carrying four correlated subqueries — cluster size, cluster
     * graduations, and the creator's prior counts — evaluated once per row. At six thousand launches
     * in a six-hour window that measured **10.3 seconds**; the same select without them is 22 ms, and
     * the same counts as plain GROUP BYs are 105 ms and 35 ms.
     *
     * The cost was not confined to the feed. node:sqlite is synchronous, so those ten seconds blocked
     * the whole server: opening a card queued behind the feed the page had just requested, and since
     * the page polls every five seconds while the answer took ten, the queue only grew. The slow
     * card was this query, not the card.
     */
    const meta = db.prepare(`
      SELECT l.token, l.symbol, l.name, l.ts, l.exempt_count, l.initial_buy_wei, l.pair_token, l.phase,
             l.launch_sender, l.deployer, l.symbol_key,
             q.symbol AS quote_symbol, q.decimals AS quote_decimals,
             g.ts AS grad_ts
      FROM launches l
      LEFT JOIN quote_assets q ON q.address = l.pair_token
      LEFT JOIN graduations g ON g.token = l.token
      WHERE l.ts >= ?`).all(since) as Array<Record<string, unknown>>;

    const { clusters, devTotal, devBest, counts } = aggregates(since);

    const ZERO = "0x0000000000000000000000000000000000000000";
    for (const m of meta) {
      const eth = m.pair_token === ZERO;
      const dec = eth ? 18 : Number(m.quote_decimals ?? 18);
      m.quote_symbol = eth ? "ETH" : (m.quote_symbol ?? "?");
      m.quote_decimals = dec;
      m.self_buy = m.initial_buy_wei === null ? null : formatUnits(BigInt(m.initial_buy_wei as string), dec);
      m.is_eth = eth;
      m.graduated = m.grad_ts !== null ? 1 : 0;
      m.grad_secs = m.grad_ts === null ? null : Number(m.grad_ts) - Number(m.ts);
      const c = m.symbol_key ? clusters.get(m.symbol_key as string) : undefined;
      m.cluster_total = c?.n ?? 0;
      m.cluster_grad = c?.g ?? 0;
      m.dev_total = devTotal.get(m.deployer as string) ?? 1;
      // The creator's high-water mark, already formatted: the row shows a figure, not a calculation.
      // Null where nobody has read any of their earlier curves, which the list says out loud rather
      // than rendering as a zero.
      // Skip past this row's own launch: what is wanted is the creator's record, not this token's.
      const best = (devBest.get(m.deployer as string) ?? []).find((b) => b.token !== m.token);
      m.dev_best_usd = best ? formatUsd(best.usd) : null;
      m.dev_best_symbol = best ? best.symbol : null;
      m.dev_best_token = best ? best.token : null;
      delete m.initial_buy_wei;
      delete m.grad_ts;
    }
    const byToken = new Map(meta.map((m) => [m.token as string, m]));
    const hour = db.prepare(`
      SELECT count(*) n, sum(token IN (SELECT token FROM graduations)) g FROM launches WHERE ts >= ?`,
    ).get(now - 3600) as { n: number; g: number | null };

    const payload = {
      hasModel: model !== null,
      health: health(),
      order,
      lastHour: { launches: hour.n, graduated: hour.g ?? 0 },
      headBlock: Number(getMeta(db, "live_head_block") ?? 0) || null,
      modelTrainedAt: existsSync("./data/model.json") ? Math.floor(statSync("./data/model.json").mtimeMs / 1000) : null,
      // The feed is capped, and a list that silently hides two thousand launches reads as if it
      // were the whole window. The UI says so out loud, so this has to come back with it.
      shown: rows.length,
      inWindow: page?.total ?? 0,
      matched: page?.matched ?? 0,
      minScore: minP,
      counts,
      items: rows.map((r) => ({ ...r, meta: byToken.get(r.token) ?? null })),
    };
    sendJson(res, holdFeed(feedKey, payload));
    return;
  }

  if (url.pathname.startsWith("/api/token/")) {
    const token = url.pathname.slice("/api/token/".length).toLowerCase();
    const row = db.prepare("SELECT curve, block FROM launches WHERE token = ?").get(token) as
      | { curve: string; block: number } | undefined;
    if (!row) { json(res, { error: "unknown token" }, 404); return; }

    // Curve trades are pulled the first time a card is opened, then cached. The read is one
    // eth_getLogs and usually lands well under a second — but a busy curve or a rate-limited endpoint
    // can hold it for far longer, and a card that shows nothing until then reads as broken. So the
    // card waits briefly and answers with what it has; the read finishes in the background and the
    // next open has the trades. The panel already says "not indexed yet" for exactly this case.
    const done = db.prepare("SELECT to_block FROM curve_indexed WHERE token = ?").get(token) as
      | { to_block: number } | undefined;
    if (!indexing.has(token)) {
      indexing.add(token);
      const work = (async () => {
        try {
          const head = await chainHead();
          const from = done ? done.to_block + 1 : row.block;
          const to = Math.min(head, row.block + 900_000); // about a day of blocks after launch
          if (to > from) await indexCurve(db, token, row.curve, from, to);
        } catch {
          // A card is still worth showing without its trades; the section says so.
        } finally {
          indexing.delete(token);
        }
      })();
      await Promise.race([work, sleep(1500)]);
    }

    void backfillCreatorPeaks(token);

    const card = buildCard(db, token);
    if (!card) { json(res, { error: "unknown token" }, 404); return; }
    json(res, { card, score: model ? scoreOne(db, model, token) : null });
    return;
  }

  res.writeHead(404).end("not found");
});

server.listen(CFG.boardPort, CFG.boardHost, () => {
  console.log(`augur board on http://${CFG.boardHost}:${CFG.boardPort}`);
  if (!model) console.log("no model yet. Run: npm run train");
});
