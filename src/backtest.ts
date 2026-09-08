import { buildDataset, type Row } from "./features.ts";
import { predict, type GbdtModel } from "./model/gbdt.ts";
import { quotePerToken } from "./pool.ts";
import { BLOCKS_PER_SECOND, SNIPE_WINDOW_BLOCKS } from "./curve.ts";
import type { DB } from "./db.ts";

/**
 * What the ranking is worth in money.
 *
 * Every other number in this project is about ordering: ROC-AUC, average precision, the shortlist's
 * 3.7x lift over chance. All of them answer "does the top of the list hold more graduations than the
 * bottom", and none of them answer the only question a reader actually has, which is whether acting
 * on that list leaves you with more than you started with. Those are different questions, and a
 * model can win the first and lose the second: graduation is a threshold the price crosses on its
 * way up, and a trader who cannot buy before the crossing collects none of it.
 *
 * This file replays the board against the price paths that actually happened. It buys nothing and
 * needs no key — it reads the same trades the cards already show and asks what a fixed rule would
 * have returned across every launch in a window.
 *
 * Three rules keep the answer from flattering itself, and each of them costs sample size:
 *
 * 1. **Only fully-covered hours.** Curve trades are read on demand, so a launch that has a price
 *    path often has one *because somebody opened its card* — and cards get opened for launches that
 *    scored well. Backtesting that sample measures the reader's attention, not the model. Only hours
 *    where nearly every launch was read are eligible, which is the same discipline `train` applies
 *    to enrichment and for the same reason.
 * 2. **Every price comes from a trade that happened.** No curve formula is fitted, no price is
 *    interpolated, and no exit is priced at a level the token never traded at. Where the data cannot
 *    say what a position was worth, the trade is dropped and counted as dropped.
 * 3. **Nothing after the entry block is used to decide the entry**, and nothing after the exit is
 *    used to price it. A take-profit at 2x fills if and only if the path reached 2x after we were
 *    in — which is what a limit order does, so it needs the running maximum and not the future.
 */

/** A price the token actually traded at, in raw quote units per raw token unit. */
export type PathPoint = { block: number; price: number; side: "buy" | "sell" };

/**
 * The 99% opening tax runs for three seconds, so the earliest a non-exempt wallet can buy without
 * handing almost everything to the creator is just after it. This is the floor on entry delay, not
 * a tuning knob: below it the simulation would be pricing a trade nobody can place.
 */
export const MIN_ENTRY_BLOCKS = SNIPE_WINDOW_BLOCKS + 1;

export type EntryRule = {
  /** Blocks after the launch block at which the buy lands. ~9.91 blocks is a second. */
  delayBlocks: number;
  /** Fraction added to the fill price for our own size moving the curve. Measured, not assumed. */
  impact: number;
};

export type ExitRule = {
  /** Sell the whole position the first time the price reaches this multiple of entry. */
  takeProfit: number | null;
  /** Sell the whole position the first time the price falls to this multiple of entry. */
  stopLoss: number | null;
  /** Give up and sell at whatever it is worth this many blocks after entry. */
  holdBlocks: number;
  /** Whether a limit sell may still fill in the pool after the token graduates off the curve. */
  followIntoPool: boolean;
};

/**
 * What a round trip costs beyond the price move.
 *
 * Measured from the trades rather than guessed: `fee_wei` and `tax_wei` are on every CurveBuy, and
 * across 668,243 of them the fee runs 1.09% and the creator's tax 0.43% of the quote paid. Both are
 * charged on the way in and on the way out, so a flat position that never moves comes back smaller.
 */
export type Costs = { buy: number; sell: number };

export type Trade = {
  token: string;
  launchBlock: number;
  entryBlock: number;
  entryPrice: number;
  exitBlock: number;
  exitPrice: number;
  exitReason: "take-profit" | "stop-loss" | "timeout" | "pool-take-profit" | "graduation";
  /** Exit over entry, before costs. */
  gross: number;
  /** What a unit staked came back as, after both sides of the round trip. */
  net: number;
};

/** Why a launch produced no trade. Counted rather than hidden: the drops are half the answer. */
export type Drop = "no-path" | "no-price-at-entry" | "no-price-after-entry";

export type Attempt = { token: string; trade: Trade | null; drop: Drop | null };

/**
 * Every curve trade for a set of tokens, grouped and ordered.
 *
 * One scan rather than one query per token: at forty thousand launches the per-token form spends
 * most of its time in statement overhead, and the whole window fits in memory comfortably — 668,000
 * trades is about 40 MB as three numbers each.
 */
export function pricePaths(db: DB, tokens: Set<string>): Map<string, PathPoint[]> {
  const out = new Map<string, PathPoint[]>();
  const rows = db.prepare(
    "SELECT token, side, quote_wei, token_amt, block FROM curve_trades ORDER BY token, block, log_index",
  ).iterate() as Iterable<{ token: string; side: string; quote_wei: string; token_amt: string; block: number }>;

  for (const r of rows) {
    if (!tokens.has(r.token)) continue;
    const amt = Number(r.token_amt);
    const quote = Number(r.quote_wei);
    // A trade that moved no tokens has no price, and one that moved no quote is a transfer dressed
    // as a trade. Either would divide into a zero or an infinity and poison every ratio downstream.
    if (!(amt > 0) || !(quote > 0)) continue;
    const price = quote / amt;
    if (!Number.isFinite(price) || price <= 0) continue;
    let arr = out.get(r.token);
    if (!arr) out.set(r.token, (arr = []));
    arr.push({ block: r.block, price, side: r.side === "sell" ? "sell" : "buy" });
  }
  return out;
}

/**
 * The pool's opening price and its peak, in the same units as the curve path.
 *
 * Only two points, because only two are stored: keeping a price series for every graduated pool is
 * the disk cost `pool.ts` explains at length. Two is enough for a limit sell and not enough for a
 * trailing stop, which is why every exit rule here is limit-shaped.
 *
 * The units are the trap. A curve price here is `quote_wei / token_amt` — raw units both sides,
 * because that is what the trade rows carry. `quotePerToken` returns *whole* quote per *whole*
 * token, having already put the decimal gap back. Where the quote asset is the 6-decimal stablecoin
 * and the token has 18, those two differ by a factor of 10^12, and a position that crossed from the
 * curve into the pool priced its exit a trillion times above its entry. That produced a single
 * launch returning 4,051,207,400x in the sweep, which is the only reason it was noticed: a bug this
 * size is visible, and the same bug on an 18-decimal quote asset is exactly 1.0 and invisible.
 *
 * So the pool leg is converted back down into the curve's raw units, and `checkPoolJoin` measures
 * whether the two legs actually meet.
 */
export type PoolLeg = { openPrice: number; peakPrice: number; peakBlock: number };

export function poolLegs(db: DB, tokens: Set<string>): Map<string, PoolLeg> {
  const out = new Map<string, PoolLeg>();
  const rows = db.prepare(`
    SELECT p.token, p.token_is_c1, p.dec0, p.dec1, p.init_sqrt,
           k.min_sqrt, k.max_sqrt, k.min_block, k.max_block
    FROM pools p JOIN pool_peaks k ON k.pool_id = p.pool_id`).all() as Array<{
      token: string; token_is_c1: number; dec0: number; dec1: number; init_sqrt: string;
      min_sqrt: string; max_sqrt: string; min_block: number; max_block: number;
    }>;

  for (const r of rows) {
    if (!tokens.has(r.token)) continue;
    // The token's price peaks where its own side of the pair is dearest, which is the low end of the
    // ratio when it is currency1. Reading the same end for every pool silently inverts half of them.
    const peakSqrt = r.token_is_c1 ? r.min_sqrt : r.max_sqrt;
    const peakBlock = r.token_is_c1 ? r.min_block : r.max_block;
    // Back into the raw units the curve trades are in, so a ratio across the two legs is a price
    // move and not a decimal conversion.
    const tokenDec = r.token_is_c1 ? r.dec1 : r.dec0;
    const quoteDec = r.token_is_c1 ? r.dec0 : r.dec1;
    const toRaw = 10 ** (quoteDec - tokenDec);
    const openPrice = quotePerToken(r.init_sqrt, r) * toRaw;
    const peakPrice = quotePerToken(peakSqrt, r) * toRaw;
    if (!(openPrice > 0) || !(peakPrice > 0)) continue;
    out.set(r.token, { openPrice, peakPrice, peakBlock });
  }
  return out;
}

/**
 * Do the two legs actually meet?
 *
 * A graduated token hands over from the curve to the pool at one moment, so the pool's opening price
 * and the curve's last price are the same price seen twice. Their ratio is therefore a unit test
 * that runs on real data: it should sit at 1. Anything else means the two legs are measured in
 * different units, and every multiple that crosses the handover is wrong by that factor.
 */
export function checkPoolJoin(
  paths: Map<string, PathPoint[]>, pools: Map<string, PoolLeg>,
): { n: number; median: number; within2x: number } {
  const ratios: number[] = [];
  for (const [token, pool] of pools) {
    const path = paths.get(token);
    if (!path?.length) continue;
    const last = path[path.length - 1].price;
    if (!(last > 0)) continue;
    ratios.push(pool.openPrice / last);
  }
  if (!ratios.length) return { n: 0, median: 0, within2x: 0 };
  ratios.sort((a, b) => a - b);
  return {
    n: ratios.length,
    median: ratios[Math.floor(ratios.length / 2)],
    within2x: ratios.filter((r) => r > 0.5 && r < 2).length / ratios.length,
  };
}

/**
 * One position, from a rule and a path.
 *
 * The entry price is the last price the token traded at strictly before the entry block. Strictly,
 * because a fill in the same block as an existing trade assumes we won the ordering inside that
 * block, and a backtest that quietly wins every race reports a number nobody can reproduce.
 *
 * The exit walks forward from the entry and takes the first point that satisfies a rule. A
 * take-profit is checked against the price the path reached, not against where it closed: a limit
 * order sitting at 2x fills when the token prints 2x, whether or not it is still there afterwards.
 */
export function simulateOne(
  token: string, path: PathPoint[], launchBlock: number, entry: EntryRule, exit: ExitRule,
  costs: Costs, pool: PoolLeg | null, gradBlock: number | null,
): Attempt {
  if (!path.length) return { token, trade: null, drop: "no-path" };

  const entryBlock = launchBlock + entry.delayBlocks;

  // The last print before we could have acted. Nothing at all means the curve had not traded yet,
  // and the launch price is not a price we could buy at — the first trade is.
  let base = 0;
  for (const p of path) {
    if (p.block >= entryBlock) break;
    base = p.price;
  }
  if (!(base > 0)) return { token, trade: null, drop: "no-price-at-entry" };

  const entryPrice = base * (1 + entry.impact);
  const after = path.filter((p) => p.block >= entryBlock);
  if (!after.length && !pool) return { token, trade: null, drop: "no-price-after-entry" };

  const tp = exit.takeProfit === null ? null : entryPrice * exit.takeProfit;
  const sl = exit.stopLoss === null ? null : entryPrice * exit.stopLoss;
  const deadline = entryBlock + exit.holdBlocks;

  let last = base;
  let lastBlock = entryBlock;
  for (const p of after) {
    if (p.block > deadline) break;
    if (gradBlock !== null && p.block > gradBlock) break;
    if (tp !== null && p.price >= tp) return done(token, launchBlock, entryBlock, entryPrice, p.block, tp, "take-profit", costs, entry);
    if (sl !== null && p.price <= sl) return done(token, launchBlock, entryBlock, entryPrice, p.block, sl, "stop-loss", costs, entry);
    last = p.price;
    lastBlock = p.block;
  }

  // The curve ran out before the rule fired. If the token graduated and we are willing to hold, the
  // limit order goes with it: it fills in the pool exactly when the pool's peak reached the target,
  // and the peak is the one thing stored for every pool.
  if (
    exit.followIntoPool && pool && tp !== null && gradBlock !== null &&
    pool.peakPrice >= tp && pool.peakBlock > entryBlock
  ) {
    return done(token, launchBlock, entryBlock, entryPrice, pool.peakBlock, tp, "pool-take-profit", costs, entry);
  }

  // Otherwise we are out at whatever the last observable price was. For a graduated token that is
  // the pool's opening price, which is where the curve handed the token over; for everything else it
  // is the last curve print inside the horizon. Neither invents a level the token never traded at.
  const exitPrice = gradBlock !== null && pool ? pool.openPrice : last;
  const reason = gradBlock !== null && pool ? "graduation" : "timeout";
  return done(token, launchBlock, entryBlock, entryPrice, lastBlock, exitPrice, reason, costs, entry);
}

function done(
  token: string, launchBlock: number, entryBlock: number, entryPrice: number,
  exitBlock: number, exitPrice: number, exitReason: Trade["exitReason"], costs: Costs, entry: EntryRule,
): Attempt {
  const gross = exitPrice / entryPrice;
  // Sold into the same impact we bought through: our size moves the price against us both ways.
  const net = gross * (1 - entry.impact) * (1 - costs.buy) * (1 - costs.sell);
  return {
    token,
    trade: { token, launchBlock, entryBlock, entryPrice, exitBlock, exitPrice, exitReason, gross, net },
    drop: null,
  };
}

/**
 * What the round trip costs, measured from the trades in the window rather than assumed.
 *
 * Both fields are charged as a fraction of the quote paid, and both are on every CurveBuy, so this
 * is a read rather than an estimate. A caller can override it; the point of measuring is that the
 * default is not a number somebody liked the look of.
 */
export function measureCosts(db: DB): Costs {
  const r = db.prepare(`
    SELECT AVG(CAST(fee_wei AS REAL) / CAST(quote_wei AS REAL)) fee,
           AVG(CAST(tax_wei AS REAL) / CAST(quote_wei AS REAL)) tax
    FROM curve_trades WHERE CAST(quote_wei AS REAL) > 0`).get() as { fee: number | null; tax: number | null };
  const side = (r.fee ?? 0.011) + (r.tax ?? 0.004);
  return { buy: side, sell: side };
}

/**
 * How far a buy of a given size moves the curve, measured across consecutive prints.
 *
 * Our own order is not in the data, so its impact has to come from someone else's. Each buy in the
 * path moved the price from the previous print to its own, and the size that did it is on the trade;
 * the median move per unit of size is what a comparable order would pay. Taking the median rather
 * than the mean keeps a handful of enormous prints from setting the cost for a small one.
 */
export function measureImpact(db: DB, sizeQuoteWei: number): number {
  const rows = db.prepare(`
    SELECT token, quote_wei, token_amt, block, log_index FROM curve_trades
    WHERE side = 'buy' ORDER BY token, block, log_index LIMIT 400000`).all() as Array<
      { token: string; quote_wei: string; token_amt: string; block: number; log_index: number }>;

  const ratios: number[] = [];
  let prevToken = "";
  let prevPrice = 0;
  for (const r of rows) {
    const amt = Number(r.token_amt);
    const quote = Number(r.quote_wei);
    if (!(amt > 0) || !(quote > 0)) continue;
    const price = quote / amt;
    if (r.token === prevToken && prevPrice > 0) {
      const move = price / prevPrice - 1;
      // Per unit of size, so it can be scaled to the size we are simulating. Moves that go backwards
      // are other people's sells landing between two buys, and are not this buy's impact.
      if (move > 0 && move < 1) ratios.push(move / quote);
    }
    prevToken = r.token;
    prevPrice = price;
  }
  if (!ratios.length) return 0;
  ratios.sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];
  return Math.min(median * sizeQuoteWei, 0.5);
}

/**
 * The hours a backtest is allowed to use.
 *
 * An hour qualifies when nearly every launch in it had its curve read. Below that the sample is
 * whatever somebody clicked on, and what somebody clicks on is the top of the ranking — which is
 * precisely the thing being measured, so the bias points the flattering way.
 */
export function coveredHours(db: DB, minCoverage = 0.98, minLaunches = 100): number[] {
  const rows = db.prepare(`
    SELECT CAST(l.ts / 3600 AS INTEGER) h, COUNT(*) n,
           SUM(CASE WHEN ci.token IS NULL THEN 0 ELSE 1 END) k
    FROM launches l LEFT JOIN curve_indexed ci ON ci.token = l.token
    GROUP BY h ORDER BY h`).all() as Array<{ h: number; n: number; k: number }>;
  return rows.filter((r) => r.n >= minLaunches && r.k / r.n >= minCoverage).map((r) => r.h);
}

/**
 * Where each launch stood on the board at the moment it was scored.
 *
 * The board ranks a launch against everything from the previous six hours, so a rank is only
 * meaningful relative to the launches that existed alongside it. Recomputing that for every launch
 * naively is quadratic; this walks the window once, keeping a count of live scores in buckets, which
 * makes each rank a prefix sum.
 *
 * Scores themselves are not replayed through time because they do not need to be: features are
 * computed strictly from history earlier than the launch, so a launch's score is the same whenever
 * it is built. Only the peer group moves.
 *
 * A launch near the start of the data has no six hours behind it, so it is ranked against a handful
 * of peers or against itself alone — and comes out in the top percentile for no reason other than
 * being early. On a live board that is correct and harmless; in a backtest it manufactures a
 * shortlist out of whichever launches happen to be first, so those launches get NaN and are dropped
 * rather than ranked against a window that was not there.
 */
export const MIN_PEERS = 50;

export function replayRanks(rows: Row[], scores: Float64Array, windowSec = 6 * 3600): Float64Array {
  const n = rows.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => rows[a].ts - rows[b].ts);

  // Bucket by the score's own global rank, so the tree is dense and exact rather than binned.
  const byScore = Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[a] - scores[b]);
  const slot = new Int32Array(n);
  byScore.forEach((idx, pos) => { slot[idx] = pos + 1; });

  const tree = new Int32Array(n + 1);
  const add = (i: number, v: number): void => { for (let x = i; x <= n; x += x & -x) tree[x] += v; };
  const sum = (i: number): number => { let s = 0; for (let x = i; x > 0; x -= x & -x) s += tree[x]; return s; };

  const percentile = new Float64Array(n);
  const earliest = rows[order[0]].ts;
  let head = 0;
  let tail = 0;
  for (const i of order) {
    const t = rows[i].ts;
    while (head < n && rows[order[head]].ts <= t) { add(slot[order[head]], 1); head++; }
    while (tail < head && rows[order[tail]].ts < t - windowSec) { add(slot[order[tail]], -1); tail++; }
    const live = head - tail;
    if (live < MIN_PEERS || t - earliest < windowSec) { percentile[i] = NaN; continue; }
    // How many peers scored at least as well. Rank 1 is the best of the window.
    const better = live - sum(slot[i]);
    percentile[i] = 100 * (1 - better / (live - 1));
  }
  return percentile;
}

export type Summary = {
  label: string;
  launches: number;
  trades: number;
  drops: Record<Drop, number>;
  wins: number;
  /** What one unit staked on a launch that could actually be filled came back as, averaged. */
  meanNet: number;
  medianNet: number;
  /**
   * The cohort staked equally across every launch in it, with the unfillable ones returning the
   * stake untouched. This is the number a reader who follows the whole list actually experiences.
   */
  totalReturn: number;
  best: number;
  exitReasons: Record<string, number>;
};

export function summarise(label: string, attempts: Attempt[]): Summary {
  const drops: Record<Drop, number> = { "no-path": 0, "no-price-at-entry": 0, "no-price-after-entry": 0 };
  const exitReasons: Record<string, number> = {};
  const nets: number[] = [];
  for (const a of attempts) {
    if (a.drop) { drops[a.drop]++; continue; }
    if (!a.trade) continue;
    nets.push(a.trade.net);
    exitReasons[a.trade.exitReason] = (exitReasons[a.trade.exitReason] ?? 0) + 1;
  }
  const sorted = [...nets].sort((a, b) => a - b);
  const total = nets.reduce((s, v) => s + v, 0);
  return {
    label,
    launches: attempts.length,
    trades: nets.length,
    drops,
    wins: nets.filter((v) => v > 1).length,
    meanNet: nets.length ? total / nets.length : 0,
    medianNet: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
    totalReturn: attempts.length ? (total + (attempts.length - nets.length)) / attempts.length : 0,
    best: sorted.length ? sorted[sorted.length - 1] : 0,
    exitReasons,
  };
}

/**
 * How wide the answer is.
 *
 * A mean over positions whose median is 0.72 and whose best is 40x is not a number with a small
 * error bar — it is a number one or two launches decide. Resampling the same positions with
 * replacement says how much of the result is the strategy and how much is which week it was.
 *
 * Deterministic on purpose: a seeded generator means two runs of the same window print the same
 * interval, so a reader can check the figure rather than watch it wobble.
 */
export function bootstrapMean(
  nets: number[], iterations = 2000, seed = 0x9e3779b9,
): { lo: number; hi: number; median: number } {
  if (!nets.length) return { lo: 0, hi: 0, median: 0 };
  let state = seed >>> 0;
  const rand = (): number => {
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x100000000;
  };
  const means = new Float64Array(iterations);
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < nets.length; j++) sum += nets[Math.floor(rand() * nets.length)];
    means[i] = sum / nets.length;
  }
  const sorted = Array.from(means).sort((a, b) => a - b);
  return {
    lo: sorted[Math.floor(0.05 * iterations)],
    hi: sorted[Math.floor(0.95 * iterations)],
    median: sorted[Math.floor(0.5 * iterations)],
  };
}

/**
 * What the result looks like without its luckiest positions.
 *
 * If dropping the single best trade takes a cohort from profitable to not, the cohort did not have
 * an edge — it had one token. Reported rather than corrected for: the tail is real and a trader does
 * collect it, but a reader is entitled to know the whole answer rests on it.
 */
export function withoutBest(nets: number[], k: number): number {
  if (nets.length <= k) return 0;
  const sorted = [...nets].sort((a, b) => a - b);
  const kept = sorted.slice(0, sorted.length - k);
  return kept.reduce((s, v) => s + v, 0) / kept.length;
}

/** Every filled position's net multiple, for the statistics above. */
export function nets(attempts: Attempt[]): number[] {
  return attempts.filter((a) => a.trade).map((a) => (a.trade as Trade).net);
}

/** Everything a run needs, so the CLI stays a printer and this stays testable. */
export type RunOptions = {
  entry: EntryRule;
  exit: ExitRule;
  costs: Costs;
  /** Percentile floor for the cohort, 90 being the shortlist the README describes. */
  cohorts: Array<{ label: string; minPercentile: number }>;
  minCoverage: number;
  /** A launch younger than this has not finished doing whatever it will do. */
  settleSec: number;
};

/**
 * Everything a rule is evaluated against, built once.
 *
 * The expensive half of a backtest is the same for every rule: the feature matrix costs about five
 * seconds, the price paths a scan of every trade, the rank replay a sort of the whole database. The
 * cheap half is walking a path with a threshold. Separating them is what makes searching sixty rules
 * take one build instead of sixty, and it is the difference between a sweep that runs in seconds and
 * one nobody waits for.
 */
export type Context = {
  hours: number[];
  rows: Row[];
  paths: Map<string, PathPoint[]>;
  pools: Map<string, PoolLeg>;
  grads: Map<string, number>;
  percentile: Map<string, number>;
};

export function prepare(db: DB, model: GbdtModel, opts: Pick<RunOptions, "minCoverage" | "settleSec">): Context {
  const hours = coveredHours(db, opts.minCoverage);
  const hourSet = new Set(hours);
  const now = Math.floor(Date.now() / 1000);

  const all = buildDataset(db, { since: 0 });

  // Ranks are against every launch of the trailing six hours, covered or not — that is the board the
  // reader saw. Restricting the peer group to covered launches would rank a launch against a tenth
  // of its real competition and hand out top percentiles that never existed.
  const scores = new Float64Array(all.length);
  for (let i = 0; i < all.length; i++) scores[i] = predict(model, all[i].x);
  const pcts = replayRanks(all, scores);
  const percentile = new Map<string, number>();
  all.forEach((r, i) => { if (Number.isFinite(pcts[i])) percentile.set(r.token, pcts[i]); });

  const rows = all.filter((r) =>
    hourSet.has(Math.floor(r.ts / 3600)) && r.ts <= now - opts.settleSec && percentile.has(r.token)
  );

  const tokens = new Set(rows.map((r) => r.token));
  const paths = pricePaths(db, tokens);
  const pools = poolLegs(db, tokens);
  const gradRows = db.prepare("SELECT token, block FROM graduations").all() as Array<{ token: string; block: number }>;
  const grads = new Map(gradRows.filter((g) => tokens.has(g.token)).map((g) => [g.token, g.block]));

  return { hours, rows, paths, pools, grads, percentile };
}

/** One rule over a prepared context. Cheap enough to call in a loop. */
export function simulate(ctx: Context, entry: EntryRule, exit: ExitRule, costs: Costs): Map<string, Attempt> {
  const out = new Map<string, Attempt>();
  for (const r of ctx.rows) {
    out.set(r.token, simulateOne(
      r.token, ctx.paths.get(r.token) ?? [], r.block, entry, exit, costs,
      ctx.pools.get(r.token) ?? null, ctx.grads.get(r.token) ?? null,
    ));
  }
  return out;
}

/** The cohort of a run: every launch whose replayed percentile clears a floor. */
export function cohort(
  ctx: Context, attempts: Map<string, Attempt>, minPercentile: number,
  within?: (token: string) => boolean,
): Attempt[] {
  const out: Attempt[] = [];
  for (const [token, a] of attempts) {
    const pct = ctx.percentile.get(token);
    if (pct === undefined || pct < minPercentile) continue;
    if (within && !within(token)) continue;
    out.push(a);
  }
  return out;
}

export type RunResult = {
  hours: number[];
  eligible: number;
  summaries: Summary[];
  ctx: Context;
  attempts: Map<string, Attempt>;
};

export function runBacktest(db: DB, model: GbdtModel, opts: RunOptions): RunResult {
  const ctx = prepare(db, model, opts);
  const attempts = simulate(ctx, opts.entry, opts.exit, opts.costs);
  const summaries = opts.cohorts.map((c) => summarise(c.label, cohort(ctx, attempts, c.minPercentile)));
  return { hours: ctx.hours, eligible: ctx.rows.length, summaries, ctx, attempts };
}

export { BLOCKS_PER_SECOND };
