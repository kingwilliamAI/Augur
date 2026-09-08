import { writeFileSync } from "node:fs";
import { buildDataset, dropCensored, FEATURES, type Row } from "../features.ts";
import { calibrate, predict, serialize, train, type GbdtModel } from "./gbdt.ts";
import type { DB } from "../db.ts";

export type Evaluation = {
  n: number; positives: number; baseRate: number;
  prAuc: number; prAucLift: number; rocAuc: number;
  topDecilePrecision: number; topDecileLift: number;
  top1pctPrecision: number;
  calibration: Array<{ bucket: string; n: number; predicted: number; actual: number }>;
};

/**
 * Splits by time, never at random. Launch tactics drift from day to day, so a random split lets the
 * model see the same hour it is tested on and reports a score the live product will never reach.
 */
export function temporalSplit(rows: Row[], trainFrac = 0.6, calibFrac = 0.2): { tr: Row[]; ca: Row[]; te: Row[] } {
  const sorted = [...rows].sort((a, b) => a.ts - b.ts || a.block - b.block);
  const a = Math.floor(sorted.length * trainFrac);
  const b = Math.floor(sorted.length * (trainFrac + calibFrac));
  return { tr: sorted.slice(0, a), ca: sorted.slice(a, b), te: sorted.slice(b) };
}

const toXY = (rows: Row[]): { X: Float64Array[]; y: Uint8Array } => ({
  X: rows.map((r) => r.x),
  y: Uint8Array.from(rows.map((r) => r.label)),
});

/**
 * Average precision and ROC-AUC. Average precision is the headline: with a 2.5% positive class,
 * ROC-AUC flatters a model that is useless at the top of the ranking, and the top of the ranking is
 * the only part a trader ever looks at.
 */
export function evaluate(model: GbdtModel, rows: Row[]): Evaluation {
  const scored = rows
    .map((r) => ({ p: predict(model, r.x), y: r.label }))
    .sort((a, b) => b.p - a.p);
  const n = scored.length;
  const positives = scored.reduce((s, r) => s + r.y, 0);
  const baseRate = positives / n;

  let tp = 0;
  let ap = 0;
  for (let i = 0; i < n; i++) if (scored[i].y) { tp++; ap += tp / (i + 1); }
  const prAuc = positives ? ap / positives : 0;

  // ROC-AUC via the rank-sum identity.
  let rankSum = 0;
  for (let i = 0; i < n; i++) if (scored[i].y) rankSum += n - i;
  const negatives = n - positives;
  const rocAuc = positives && negatives ? (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives) : 0.5;

  const dec = scored.slice(0, Math.max(1, Math.floor(n * 0.1)));
  const topDecilePrecision = dec.reduce((s, r) => s + r.y, 0) / dec.length;
  const one = scored.slice(0, Math.max(1, Math.floor(n * 0.01)));
  const top1pctPrecision = one.reduce((s, r) => s + r.y, 0) / one.length;

  const calibration: Evaluation["calibration"] = [];
  const buckets = 6;
  for (let b = 0; b < buckets; b++) {
    const lo = Math.floor((b * n) / buckets);
    const hi = Math.floor(((b + 1) * n) / buckets);
    const slice = scored.slice(lo, hi);
    if (!slice.length) continue;
    calibration.push({
      bucket: `${b + 1}/${buckets}`,
      n: slice.length,
      predicted: slice.reduce((s, r) => s + r.p, 0) / slice.length,
      actual: slice.reduce((s, r) => s + r.y, 0) / slice.length,
    });
  }

  return {
    n, positives, baseRate, prAuc,
    prAucLift: baseRate ? prAuc / baseRate : 0,
    rocAuc, topDecilePrecision,
    topDecileLift: baseRate ? topDecilePrecision / baseRate : 0,
    top1pctPrecision, calibration,
  };
}

export type TrainResult = { model: GbdtModel; evaluation: Evaluation; rows: number; window: { from: number; to: number } };

/**
 * Finds the longest run of hours in which nearly every launch has been enriched.
 *
 * Enrichment is expensive, so a database usually holds a mix: some hours fully covered, others only
 * sampled. Training across that mix silently inflates the positive rate, because a sample taken to
 * study graduations over-represents them. Restricting to a contiguous, fully covered span is what
 * keeps the reported probability equal to a real one.
 */
export function fullyEnrichedWindow(db: DB, minCoverage = 0.98, minHours = 3): { from: number; to: number } | null {
  const hours = db.prepare(`
    SELECT (ts/3600)*3600 AS h, count(*) n, sum(CASE WHEN enriched_at IS NOT NULL THEN 1 ELSE 0 END) e
    FROM launches GROUP BY h ORDER BY h`).all() as Array<{ h: number; n: number; e: number }>;

  let best: { from: number; to: number; len: number } | null = null;
  let runStart: number | null = null;
  let prev: number | null = null;

  const close = (endHour: number): void => {
    if (runStart === null) return;
    const len = (endHour - runStart) / 3600 + 1;
    if (len >= minHours && (best === null || len > best.len)) best = { from: runStart, to: endHour + 3600, len };
    runStart = null;
  };

  for (const row of hours) {
    const covered = row.n > 0 && row.e / row.n >= minCoverage;
    const contiguous = prev === null || row.h === prev + 3600;
    if (!covered || !contiguous) close(prev ?? row.h);
    if (covered && runStart === null) runStart = row.h;
    prev = row.h;
  }
  close(prev ?? 0);
  return best ? { from: best.from, to: best.to } : null;
}

export function trainFromDb(db: DB, opts: { nowTs?: number; horizonSec?: number; modelPath?: string } = {}): TrainResult {
  const now = opts.nowTs ?? Math.floor(Date.now() / 1000);
  const horizon = opts.horizonSec ?? 4 * 3600;

  const window = fullyEnrichedWindow(db);
  if (!window) {
    throw new Error(
      "no contiguous span of fully enriched hours found. Run: npm run enrich-window -- --hours 10\n" +
      "Training on a partially enriched database would report a positive rate that does not exist.",
    );
  }

  const all = buildDataset(db, { labelHorizonSec: horizon });
  const inWindow = all.filter((r) => r.ts >= window.from && r.ts < window.to);
  const settled = dropCensored(inWindow, now, horizon);
  if (settled.length < 200) throw new Error(`only ${settled.length} settled rows in the enriched window; enrich more hours first`);

  const { tr, ca, te } = temporalSplit(settled);
  const trainSet = toXY(tr);
  const model = train(trainSet.X, trainSet.y, [...FEATURES]);
  const calSet = toXY(ca);
  calibrate(model, calSet.X, calSet.y);

  const evaluation = evaluate(model, te);
  if (opts.modelPath) writeFileSync(opts.modelPath, serialize(model));
  return { model, evaluation, rows: settled.length, window };
}
