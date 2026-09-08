import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { DB } from "./db.ts";
import type { Scored } from "./score.ts";

/**
 * The prediction log: what the tool said, recorded before the answer existed.
 *
 * Every number elsewhere in this project is retrospective. A rolling-origin fold still chooses its
 * own split after all the data is in hand, and a reader has to take the code's word that nothing
 * leaked. This file exists so that claim can be checked by someone who trusts none of it: each row
 * is a score written at a known wall-clock time, graded later by an on-chain fact, exportable and
 * recomputable from the export alone.
 *
 * That only works if a row can never be improved after the fact, so the write is insert-only.
 */

/** The settlement window the model is trained against; 98.5% of graduations land inside it. */
export const HORIZON_SEC = 4 * 3600;

/**
 * A launch scored later than this is not recorded at all.
 *
 * Half of all graduations happen within two minutes of launch, so a score written ten minutes late
 * is not the claim this tool makes, and grading it would flatter the log with launches whose fate
 * was already half-decided. The cut is on age alone — knowable at score time, independent of the
 * score and of the outcome — so it cannot select for anything.
 */
export const MAX_AGE_SEC = 300;

/**
 * Identifies the model file that produced a score. Retraining nightly means the log spans many
 * models, and pooling them would report a blend nobody ever ran.
 */
export function modelId(path = "./data/model.json"): string {
  if (!existsSync(path)) return "none";
  return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12);
}

export type Prediction = {
  token: string;
  launch_ts: number;
  scored_at: number;
  age_at_score: number;
  probability: number;
  /** Null for claims written before this column existed; those were never corrected. */
  raw_probability: number | null;
  rank: number;
  of: number;
  model_id: string;
  graded_at: number | null;
  label: 0 | 1 | null;
};

/**
 * Records one score. Returns false when the launch was too old to make an honest claim about, or
 * when this launch already carries a claim: the first one stands.
 */
export function record(db: DB, s: Scored, launchTs: number, model: string, now = Math.floor(Date.now() / 1000)): boolean {
  const age = now - launchTs;
  if (age > MAX_AGE_SEC || age < 0) return false;

  const res = db.prepare(`
    INSERT INTO predictions (token, launch_ts, scored_at, age_at_score, probability, raw_probability, rank, of, model_id, reasons_json)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(token) DO NOTHING`).run(
    s.token, launchTs, now, age, s.probability, s.rawProbability ?? s.probability,
    s.rank, s.of, model, JSON.stringify(s.reasons),
  );
  return Number(res.changes) > 0;
}

/**
 * Settles every claim whose horizon has closed.
 *
 * The label matches what training uses exactly — graduated, and within the horizon measured from
 * the launch — so a number here and a number from validation mean the same thing.
 */
export function grade(db: DB, now = Math.floor(Date.now() / 1000)): number {
  const res = db.prepare(`
    UPDATE predictions SET
      graded_at = ?,
      label = CASE WHEN EXISTS (
        SELECT 1 FROM graduations g
        WHERE g.token = predictions.token AND g.ts - predictions.launch_ts <= ?
      ) THEN 1 ELSE 0 END
    WHERE graded_at IS NULL AND launch_ts + ? <= ?`).run(now, HORIZON_SEC, HORIZON_SEC, now);
  return Number(res.changes) + regrade(db, now);
}

/**
 * Corrects claims that were settled against evidence which had not arrived yet.
 *
 * Grading asks whether a graduation is on record, and reads a missing row as "it did not happen".
 * Those are not the same thing. The watcher can be behind, or restart, or miss a window that a
 * later pass fills in, and then a launch that reached the pool four minutes in is settled as a
 * failure four hours later, with `graded_at` set so nothing ever looks again.
 *
 * It happened to 14 claims, every one of them a token that reached the pool between one and
 * twenty-four minutes after launch. That is 9.7% of all the positives on record, and it does not
 * merely understate the score: the live correction is fitted against these labels, so missing
 * positives push every published probability down by about a tenth.
 *
 * The asymmetry is the point. A graduation row is proof that it happened; the absence of one is
 * not proof that it did not. So a 0 may become a 1 when the evidence turns up, and a 1 is never
 * revisited.
 */
export function regrade(db: DB, now = Math.floor(Date.now() / 1000)): number {
  const res = db.prepare(`
    UPDATE predictions SET label = 1, graded_at = ?
    WHERE label = 0 AND EXISTS (
      SELECT 1 FROM graduations g
      WHERE g.token = predictions.token AND g.ts - predictions.launch_ts <= ?
    )`).run(now, HORIZON_SEC);
  return Number(res.changes);
}

export function settled(db: DB, modelFilter?: string): Prediction[] {
  const sql = `SELECT token, launch_ts, scored_at, age_at_score, probability, raw_probability, rank, of, model_id, graded_at, label
               FROM predictions WHERE label IS NOT NULL${modelFilter ? " AND model_id = ?" : ""}
               ORDER BY launch_ts`;
  const stmt = db.prepare(sql);
  return (modelFilter ? stmt.all(modelFilter) : stmt.all()) as Prediction[];
}

export type Score = {
  n: number;
  positives: number;
  baseRate: number;
  rocAuc: number;
  topDecilePrecision: number;
  topDecileLift: number;
  topDecileN: number;
  topDecileHits: number;
  calibration: Array<{ bucket: string; n: number; predicted: number; actual: number }>;
};

/**
 * Scores the log the same way validation scores a fold, so the two are directly comparable.
 *
 * The top decile is reported as a raw count as well as a rate. At a 2% base rate that decile holds
 * ten or twenty graduations, and a lift quoted to two decimals off twelve events reads far more
 * precise than it is; showing the count makes the sample size impossible to miss.
 */
export function score(rows: Array<{ probability: number; label: 0 | 1 }>): Score | null {
  const n = rows.length;
  if (n < 20) return null;

  const sorted = [...rows].sort((a, b) => b.probability - a.probability);
  const positives = sorted.reduce((s, r) => s + r.label, 0);
  const negatives = n - positives;
  const baseRate = positives / n;

  let rankSum = 0;
  for (let i = 0; i < n; i++) if (sorted[i].label) rankSum += n - i;
  const rocAuc = positives && negatives
    ? (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives)
    : 0.5;

  const decile = sorted.slice(0, Math.max(1, Math.floor(n * 0.1)));
  const hits = decile.reduce((s, r) => s + r.label, 0);
  const precision = hits / decile.length;

  const calibration: Score["calibration"] = [];
  const buckets = 5;
  for (let b = 0; b < buckets; b++) {
    const part = sorted.slice(Math.floor((b * n) / buckets), Math.floor(((b + 1) * n) / buckets));
    if (!part.length) continue;
    calibration.push({
      bucket: `${b + 1}/${buckets}`,
      n: part.length,
      predicted: part.reduce((s, r) => s + r.probability, 0) / part.length,
      actual: part.reduce((s, r) => s + r.label, 0) / part.length,
    });
  }

  return {
    n,
    positives,
    baseRate,
    rocAuc,
    topDecilePrecision: precision,
    topDecileLift: baseRate ? precision / baseRate : 0,
    topDecileN: decile.length,
    topDecileHits: hits,
    calibration,
  };
}

/** Claims whose horizon has not closed yet, so a reader can see what is still outstanding. */
export function pending(db: DB): number {
  return (db.prepare(
    "SELECT count(*) c FROM predictions WHERE label IS NULL",
  ).get() as { c: number }).c;
}
