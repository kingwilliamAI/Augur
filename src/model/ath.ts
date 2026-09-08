import { buildDataset, FEATURES, type Row } from "../features.ts";
import { calibrate, predict, train, type GbdtModel } from "./gbdt.ts";
import { quotePerToken } from "../pool.ts";
import type { DB } from "../db.ts";

/**
 * How high a launch climbs, predicted from what is knowable when it lands.
 *
 * A separate question from graduation and a separate model. Graduation is rare — about 2.3% — and
 * asks whether a launch clears one fixed bar. This asks how far it gets, which almost every launch
 * answers to some degree: measured over settled curves the peak runs from x1.03 at the tenth
 * percentile to x5.83 at the ninetieth, and 22% reach x3.
 *
 * The target is the peak as a **multiple of the launch price**, in logs. Not a market cap in
 * dollars: that needs the quote asset's price, half of launches are quoted against a tokenised
 * stock, and the ratio is what the model can actually learn — the dollar figure is the ratio times a
 * number the chain does not know. The card multiplies it back out for display.
 *
 * The peak is the *effective* one: the pool's where the launch graduated, the curve's where it did
 * not. Using the curve's for everything was teaching the model a constant on exactly the launches
 * worth predicting. A graduated token's curve high is the bar it had to clear, so measured across
 * graduated tokens it runs $36,756 at the tenth percentile to $53,357 at the ninetieth, a spread of
 * 1.5x. Their pool peaks run $47,005 to $475,899 over the same tokens, a spread of 10.1x, and sit
 * 1.58x above the curve at the median and up to 51x above it. All of the variance is after
 * graduation, and none of it was in the target.
 *
 * Only settled curves are trained on. A launch from ten minutes ago has not finished climbing, and
 * its peak-so-far is not its peak; feeding that in teaches the model that recent launches peak low.
 */

/** A launch this new has not finished climbing, so its peak is not yet its peak. */
export const SETTLE_SEC = 4 * 3600;
/** Below this many trades a "peak" is one buyer's slippage rather than a price the market reached. */
export const MIN_TRADES = 4;

export type AthRow = Row & { logPeak: number };

/**
 * Joins the feature matrix to the observed peak of each launch whose curve has been read.
 *
 * Coverage is the limit here, not the join: curves are read on demand and in bulk, so this returns
 * only the launches somebody has read. The caller reports how many that was, because a model fitted
 * on two hundred curves and one fitted on twenty thousand deserve to be trusted differently.
 */
export function buildAthDataset(db: DB, nowTs = Math.floor(Date.now() / 1000)): AthRow[] {
  const peaks = new Map<string, number>();
  /** The first price each curve traded at, kept because the pool arm below divides into it. */
  const opens = new Map<string, number>();
  // Both sides, matching how a peak is measured everywhere else and how the stored summary counts.
  // Reading only buys here meant a curve could qualify or not depending on whether it had been
  // compacted yet, which would have made membership of the training set an artefact of housekeeping.
  const rows = db.prepare(`
    SELECT token, quote_wei, token_amt FROM curve_trades
    ORDER BY token, block, log_index`).all() as
    Array<{ token: string; quote_wei: string; token_amt: string }>;

  let current = "";
  let first = 0;
  let peak = 0;
  let count = 0;
  const flush = (): void => {
    if (!current || !(first > 0) || !(peak > 0) || count < MIN_TRADES) return;
    opens.set(current, first);
    peaks.set(current, Math.log(peak / first));
  };
  for (const r of rows) {
    if (r.token !== current) { flush(); current = r.token; first = 0; peak = 0; count = 0; }
    const tokens = Number(r.token_amt);
    if (!(tokens > 0)) continue;
    const p = Number(r.quote_wei) / tokens;
    if (!(p > 0) || !Number.isFinite(p)) continue;
    if (first === 0) first = p;
    if (p > peak) peak = p;
    count++;
  }
  flush();

  // Curves folded into a summary keep their peak but no longer have the trades it came from. Their
  // target is read straight off the summary, or the training set would shrink as compaction runs
  // and would quietly become a sample of recent launches only.
  for (const r of db.prepare(`
    SELECT token, first_price, peak_price, trades FROM curve_summary
    WHERE trades >= ? AND first_price > 0 AND peak_price > 0`).all(MIN_TRADES) as
    Array<{ token: string; first_price: number; peak_price: number; trades: number }>) {
    if (opens.has(r.token)) continue;
    opens.set(r.token, r.first_price);
    peaks.set(r.token, Math.log(r.peak_price / r.first_price));
  }

  /**
   * Then let the pool answer for anything that graduated.
   *
   * Both sides are put in whole quote units per whole token before they are compared, which keeps
   * every quote asset in the set: a ratio needs no dollar price, and half of these launches are
   * quoted against a tokenised stock this project has no feed for.
   *
   * The larger of the two wins rather than the pool always, because a token can graduate and then
   * do nothing, and its curve high is then the real high.
   */
  for (const r of db.prepare(`
    SELECT p.token, p.token_is_c1, p.dec0, p.dec1, p.init_sqrt, k.min_sqrt, k.max_sqrt, l.pair_token
    FROM pools p JOIN pool_peaks k ON k.pool_id = p.pool_id JOIN launches l ON l.token = p.token`).all() as
    Array<{ token: string; token_is_c1: number; dec0: number; dec1: number;
            init_sqrt: string; min_sqrt: string; max_sqrt: string; pair_token: string }>) {
    const openRaw = opens.get(r.token);
    if (openRaw === undefined || !(openRaw > 0)) continue;

    const dec = r.token_is_c1 ? r.dec0 : r.dec1;
    // Raw curve prices are quote units per token unit; this lifts the opening to whole units so it
    // can be divided into a pool price, which already is.
    const openWhole = openRaw * (1e18 / 10 ** dec);
    const best = Math.max(
      quotePerToken(r.token_is_c1 ? r.min_sqrt : r.max_sqrt, r),
      quotePerToken(r.init_sqrt, r),
    );
    if (!(best > 0) || !Number.isFinite(best)) continue;

    const ratio = best / openWhole;
    const curveRatio = Math.exp(peaks.get(r.token) ?? 0);
    if (ratio > curveRatio && Number.isFinite(ratio)) peaks.set(r.token, Math.log(ratio));
  }

  const out: AthRow[] = [];
  for (const row of buildDataset(db)) {
    if (row.ts + SETTLE_SEC > nowTs) continue;
    const logPeak = peaks.get(row.token);
    if (logPeak === undefined) continue;
    out.push({ ...row, logPeak });
  }
  return out.sort((a, b) => a.ts - b.ts || a.block - b.block);
}

export type AthEvaluation = {
  n: number;
  medianPeak: number;
  /** Spearman rank correlation between predicted and observed peak. Rank, because the tail is long. */
  spearman: number;
  /** Median observed peak among the tenth the model rated highest, against the median overall. */
  topDecileMedian: number;
  topDecileLift: number;
  /** What a constant prediction would cost, so the model has something to beat. */
  maeModel: number;
  maeBaseline: number;
};

function spearman(a: number[], b: number[]): number {
  const rank = (v: number[]): number[] => {
    const idx = v.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(v.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const ra = rank(a), rb = rank(b), n = a.length;
  const ma = ra.reduce((s, v) => s + v, 0) / n, mb = rb.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, dbv = 0;
  for (let i = 0; i < n; i++) {
    const x = ra[i] - ma, y = rb[i] - mb;
    num += x * y; da += x * x; dbv += y * y;
  }
  return da && dbv ? num / Math.sqrt(da * dbv) : 0;
}

export function evaluateAth(model: GbdtModel, rows: AthRow[]): AthEvaluation {
  const pred = rows.map((r) => predict(model, r.x));
  const obs = rows.map((r) => r.logPeak);
  const n = rows.length;

  const sorted = [...obs].sort((a, b) => a - b);
  const medianLog = sorted[Math.floor(n / 2)];

  const order = pred.map((p, i) => [p, i] as const).sort((a, b) => b[0] - a[0]);
  const dec = order.slice(0, Math.max(1, Math.floor(n * 0.1))).map(([, i]) => obs[i]).sort((a, b) => a - b);
  const decMedian = dec[Math.floor(dec.length / 2)];

  const mae = (f: (i: number) => number): number => obs.reduce((s, o, i) => s + Math.abs(o - f(i)), 0) / n;

  return {
    n,
    medianPeak: Math.exp(medianLog),
    spearman: spearman(pred, obs),
    topDecileMedian: Math.exp(decMedian),
    topDecileLift: Math.exp(decMedian - medianLog),
    maeModel: mae((i) => pred[i]),
    maeBaseline: mae(() => medianLog),
  };
}

/** Rolling-origin folds, the same discipline the graduation model is held to. */
export function validateAth(rows: AthRow[], folds = 5): AthEvaluation[] {
  const out: AthEvaluation[] = [];
  for (let k = 0; k < folds; k++) {
    const trEnd = Math.floor(rows.length * (0.4 + (0.6 * k) / folds));
    const teEnd = Math.floor(rows.length * (0.4 + (0.6 * (k + 1)) / folds));
    const tr = rows.slice(0, trEnd);
    const te = rows.slice(trEnd, teEnd);
    if (tr.length < 100 || te.length < 40) continue;
    const m = train(tr.map((r) => r.x), tr.map((r) => r.logPeak), [...FEATURES],
      { objective: "squared", rounds: 200, learningRate: 0.05, maxDepth: 3, minChildHessian: 20 });
    out.push(evaluateAth(m, te));
  }
  return out;
}

export function trainAth(rows: AthRow[]): GbdtModel {
  return train(rows.map((r) => r.x), rows.map((r) => r.logPeak), [...FEATURES],
    { objective: "squared", rounds: 200, learningRate: 0.05, maxDepth: 3, minChildHessian: 20 });
}

/**
 * The model plus the band it is allowed to claim.
 *
 * The point estimate used to be weak, beating a constant by about 3% of mean absolute error, which
 * is why the band is the output rather than a figure. On the effective peak it beats a constant by
 * 21%, and the band is still the output: 21% is a real edge and not a reason to print one number as
 * though it were the answer. Residual quantiles come from rows the model never saw, and `coverage`
 * is what a third slice actually measured, not what was aimed for, so a reader can see when the band
 * is narrower than it should be.
 */
export type AthModel = {
  model: GbdtModel;
  /** Additive bounds in log space: a prediction p becomes [p + lo, p + hi]. */
  lo: number;
  hi: number;
  /** Share of unseen launches that actually fell inside the band. */
  coverage: number;
  /**
   * A separate model for the question the point estimate cannot answer.
   *
   * Squared loss on a heavy tail predicts the middle: its output tops out around x11 while the data
   * runs to x600, so it will never say "this one does x100". What it does do is rank, and ranking is
   * enough to answer "does this run at all" as a probability. Trained on the same features against
   * whether the peak cleared x10.
   */
  tail: GbdtModel | null;
  /** Share of launches that cleared the mark at all, so a probability can be read against it. */
  tailBase: number;
  /** Measured on unseen rows: share above the mark among the tenth the tail model rated highest. */
  tailTopDecile: number;
  trainedOn: number;
  spearman: number;
  topDecileLift: number;
  /** How much less mean absolute error than a constant, as a share, on rows it never saw. */
  maeGain: number;
};

/**
 * Half, not four fifths.
 *
 * An 80% band on this target spans 3.4x from end to end, which is honest and nearly useless to read:
 * "somewhere between $15K and $50K" is a shrug. Half the launches land inside a 1.7x span, so that
 * is what the card shows, with the coverage it actually measured printed beside it. A reader who
 * wants near-certainty has the whole distribution in the model page; a reader looking at a launch
 * wants the middle of it.
 */
export const BAND = 0.5;

/** The multiple that counts as a run, for the separate question of whether one happens at all. */
export const TAIL_AT = 10;

export function fitAthModel(rows: AthRow[]): AthModel | null {
  if (rows.length < 300) return null;
  // Three slices: fit, take residual quantiles, then measure coverage on rows that produced neither.
  const a = Math.floor(rows.length * 0.6);
  const b = Math.floor(rows.length * 0.8);
  const model = trainAth(rows.slice(0, a));

  const resid = rows.slice(a, b).map((r) => r.logPeak - predict(model, r.x)).sort((x, y) => x - y);
  const at = (p: number): number => resid[Math.min(resid.length - 1, Math.floor(resid.length * p))];
  const lo = at((1 - BAND) / 2);
  const hi = at(1 - (1 - BAND) / 2);

  const test = rows.slice(b);
  const inside = test.filter((r) => {
    const p = predict(model, r.x);
    return r.logPeak >= p + lo && r.logPeak <= p + hi;
  }).length;

  const ev = evaluateAth(model, test);

  // The tail model sees the same rows the point model was fitted on, and is scored on the same
  // held-out slice, so its numbers can be read beside the others.
  const mark = Math.log(TAIL_AT);
  const fitRows = rows.slice(0, a);
  const hits = fitRows.filter((r) => r.logPeak >= mark).length;
  let tail: GbdtModel | null = null;
  let tailTopDecile = 0;
  if (hits >= 30) {
    tail = train(fitRows.map((r) => r.x), fitRows.map((r) => (r.logPeak >= mark ? 1 : 0)), [...FEATURES],
      { objective: "logistic", rounds: 200, learningRate: 0.05, maxDepth: 3, minChildHessian: 20 });
    calibrate(tail, test.map((r) => r.x), Uint8Array.from(test.map((r) => (r.logPeak >= mark ? 1 : 0))));
    const scored = test.map((r) => ({ p: predict(tail as GbdtModel, r.x), hit: r.logPeak >= mark ? 1 : 0 }))
      .sort((x, y) => y.p - x.p);
    const dec = scored.slice(0, Math.max(1, Math.floor(scored.length * 0.1)));
    tailTopDecile = dec.length ? dec.reduce((s, r) => s + r.hit, 0) / dec.length : 0;
  }
  const tailBase = test.length ? test.filter((r) => r.logPeak >= mark).length / test.length : 0;

  return {
    model, lo, hi, tail, tailBase, tailTopDecile,
    coverage: test.length ? inside / test.length : 0,
    trainedOn: a,
    spearman: ev.spearman,
    topDecileLift: ev.topDecileLift,
    maeGain: ev.maeBaseline > 0 ? 1 - ev.maeModel / ev.maeBaseline : 0,
  };
}

/** Predicted peak for one launch, as a multiple of its launch price, with its band and tail chance. */
export function predictAth(m: AthModel, x: Float64Array): {
  multiple: number; lo: number; hi: number; tailChance: number | null;
} {
  const p = predict(m.model, x);
  return {
    multiple: Math.exp(p),
    lo: Math.exp(p + m.lo),
    hi: Math.exp(p + m.hi),
    // Platt-scaled when it was fitted, so this is a probability rather than a score that merely
    // sorts. The card still shows the base rate beside it, because a probability is only readable
    // against how often the thing happens at all.
    tailChance: m.tail ? predict(m.tail, x) : null,
  };
}

export { calibrate };
