import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Correcting the score against what actually happened, rather than against a held-out slice.
 *
 * The model's own calibration is fitted at training time on rows from the same days it learned from.
 * That answers "does this number mean what it says on the data I was built from". The prediction log
 * answers the question that matters: does it mean what it says *now*. On the first live night it did
 * not — every quintile read high, 4.39% where 2.94% happened, because the model had been fitted when
 * roughly 2.2% of launches graduated and the night ran at 1.48%.
 *
 * What this deliberately does not do is change the ranking. A two-parameter correction in log-odds
 * is monotone, so the order of the list, the shortlist, and every lift figure are untouched; only
 * the printed probability moves. That is the honest scope of the fix, and it is why applying it on
 * a launch day is safe.
 *
 * The correction belongs to one model. Claims were scored by the model that was loaded at the time,
 * and their residuals say nothing about a model trained later, so the fit is stamped with the model
 * it came from and ignored the moment that changes.
 */

export type LiveCalibration = {
  /** Fingerprint of the model these claims were scored by. */
  modelId: string;
  a: number;
  b: number;
  /** Settled claims the fit was made from. */
  n: number;
  fittedAt: number;
  /** Mean predicted and mean observed before the correction, so the drift stays visible. */
  saidBefore: number;
  wasBefore: number;
};

/** Below this the fit is noise; a night with forty graduations is thin enough already. */
export const MIN_CLAIMS = 500;
/**
 * How far the correction may go. A slope far from one, or a large shift, means something changed
 * that a two-parameter nudge should not be papering over — a different market, or a broken feature
 * pipeline — and quietly rescaling would hide it.
 */
export const MAX_SHIFT = 2.5;
export const SLOPE_RANGE: [number, number] = [0.25, 4];

const logit = (p: number): number => {
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  return Math.log(q / (1 - q));
};
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/**
 * Platt scaling over the scores as they were shown, fitted by Newton steps on the logistic
 * likelihood — the same fit the model uses internally, applied one level up.
 */
export function fitLive(rows: Array<{ probability: number; label: 0 | 1 }>): { a: number; b: number } | null {
  if (rows.length < MIN_CLAIMS) return null;
  const z = rows.map((r) => logit(r.probability));
  const y = rows.map((r) => r.label);

  let a = 1;
  let b = 0;
  for (let it = 0; it < 80; it++) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (let i = 0; i < z.length; i++) {
      const p = sigmoid(a * z[i] + b);
      const d = p - y[i];
      const w = Math.max(1e-9, p * (1 - p));
      g0 += d * z[i];
      g1 += d;
      h00 += w * z[i] * z[i];
      h01 += w * z[i];
      h11 += w;
    }
    const det = h00 * h11 - h01 * h01;
    if (Math.abs(det) < 1e-12) break;
    const da = (g0 * h11 - g1 * h01) / det;
    const dbv = (g1 * h00 - g0 * h01) / det;
    a -= da;
    b -= dbv;
    if (Math.abs(da) < 1e-9 && Math.abs(dbv) < 1e-9) break;
  }

  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a < SLOPE_RANGE[0] || a > SLOPE_RANGE[1] || Math.abs(b) > MAX_SHIFT) return null;
  return { a, b };
}

/** Applies a correction to one probability. Monotone, so it never reorders anything. */
export const applyLive = (c: Pick<LiveCalibration, "a" | "b">, p: number): number =>
  sigmoid(c.a * logit(p) + c.b);

export function loadLive(path = "./data/calibration.json"): LiveCalibration | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LiveCalibration;
  } catch {
    return null;
  }
}

export function saveLive(c: LiveCalibration, path = "./data/calibration.json"): void {
  writeFileSync(path, JSON.stringify(c, null, 2) + "\n");
}

/**
 * The correction to use, or null when this model has not been corrected yet.
 *
 * A correction belongs to one model. Claims were scored by whatever was loaded at the time, and
 * their residuals describe that model, so a fit is stamped with the model it came from and ignored
 * the moment that changes.
 *
 * This was briefly relaxed to let a fit carry across a retrain, on the reasoning that a model is
 * always retired before it can be corrected: five hundred settled claims, four hours to settle, a
 * retrain every twenty-four. The arithmetic was wrong. A model gathers about a thousand claims an
 * hour here, so it clears five hundred settled ones after roughly four and a half hours of service
 * and then has some twenty hours left in which its own claims can correct it. Measured across six
 * models: 624, 403, 1038, 860, 1287 and 952 claims an hour.
 *
 * The cost of the relaxed version was not theoretical. The correction fitted against a model that
 * over-predicted twofold was inherited by its successor, which the log shows saying 1.43% where
 * 1.40% happened; carried over, it would have printed 0.35%. A model that needs no correction is
 * the ordinary case, and inheriting one is a guess dressed as a measurement.
 */
export function liveFor(modelId: string, path?: string): LiveCalibration | null {
  const c = loadLive(path);
  return c && c.modelId === modelId ? c : null;
}
