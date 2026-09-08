import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calibrate, contributions, deserialize, predict, rawScore, serialize, train,
} from "./gbdt.ts";

/**
 * The booster is written out by hand, so nothing external would notice it quietly going wrong. A
 * subtle error in split finding or in contribution attribution does not throw: it produces a model
 * that still trains, still reports plausible metrics, and is worthless. These tests fit a dataset
 * whose answer is known in advance and check that the model recovers it.
 *
 * The synthetic data deliberately mirrors the real problem's shape: two features carry signal, one
 * is pure noise, and the positive class is rare, because a booster that looks fine on a balanced
 * toy problem can still collapse at a 2% base rate.
 */

const FEATURE_NAMES = ["signal_a", "signal_b", "noise"];
const A = 0;
const B = 1;
const NOISE = 2;

/** A PRNG independent of the model's own, so the data is not correlated with the subsample stream. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/**
 * True log-odds: `signal_a` matters most, `signal_b` less, `noise` not at all. The intercept is
 * set so the positive class lands near 2.5%, which is the graduation rate the real model faces.
 */
const trueLogit = (a: number, b: number): number => -7.6 + 4 * a + 2.5 * b;

function makeData(n: number, seed: number): { X: Float64Array[]; y: Uint8Array } {
  const rand = rng(seed);
  const X: Float64Array[] = [];
  const y = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = rand();
    const b = rand();
    X.push(Float64Array.from([a, b, rand()]));
    y[i] = rand() < sigmoid(trueLogit(a, b)) ? 1 : 0;
  }
  return { X, y };
}

function rocAuc(scores: number[], y: Uint8Array): number {
  const order = scores.map((p, i) => ({ p, y: y[i] })).sort((l, r) => r.p - l.p);
  const n = order.length;
  let positives = 0;
  for (const o of order) positives += o.y;
  const negatives = n - positives;
  if (!positives || !negatives) return 0.5;
  let rankSum = 0;
  for (let i = 0; i < n; i++) if (order[i].y) rankSum += n - i;
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

const TRAIN = makeData(20_000, 1);
const CALIB = makeData(8_000, 2);
const TEST = makeData(20_000, 3);

const fitted = train(TRAIN.X, TRAIN.y, FEATURE_NAMES);

/**
 * The best ROC-AUC anyone could score on this test set, reached by ranking on the true log-odds
 * the labels were drawn from. The labels are stochastic, so this ceiling sits well below 1 — an
 * absolute threshold would either be unreachable or so loose it proves nothing. Judging the model
 * against the ceiling is the only assertion that means "it learned what was there to learn".
 */
const BAYES_AUC = rocAuc(TEST.X.map((x) => trueLogit(x[A], x[B])), TEST.y);

test("the synthetic problem is as rare and as hard as the real one", () => {
  const rate = TRAIN.y.reduce((s, v) => s + v, 0) / TRAIN.y.length;
  assert.ok(rate > 0.01 && rate < 0.06, `base rate ${(100 * rate).toFixed(2)}% is not in the range this models`);
});

test("recovers a known signal on held-out rows, close to the theoretical ceiling", () => {
  assert.ok(BAYES_AUC > 0.75, `the planted signal is too weak to test against (ceiling ${BAYES_AUC.toFixed(3)})`);
  const auc = rocAuc(TEST.X.map((x) => predict(fitted, x)), TEST.y);
  assert.ok(
    auc > BAYES_AUC - 0.05,
    `held-out ROC-AUC ${auc.toFixed(3)} against a ceiling of ${BAYES_AUC.toFixed(3)}`,
  );
});

test("ranks the informative features above the noise one", () => {
  const total = new Float64Array(FEATURE_NAMES.length);
  for (const x of TEST.X) {
    const { contribs } = contributions(fitted, x);
    for (let f = 0; f < contribs.length; f++) total[f] += Math.abs(contribs[f]);
  }
  assert.ok(total[A] > total[NOISE] * 3, `signal_a (${total[A].toFixed(1)}) barely beats noise (${total[NOISE].toFixed(1)})`);
  assert.ok(total[B] > total[NOISE] * 2, `signal_b (${total[B].toFixed(1)}) barely beats noise (${total[NOISE].toFixed(1)})`);
  assert.ok(total[A] > total[B], "signal_a carries more of the truth than signal_b and should rank above it");
});

test("contributions add up to the score exactly", () => {
  // This is what lets a card say "these three facts moved the number" without the arithmetic
  // quietly failing to close. An attribution bug shows up here and nowhere else.
  for (const x of TEST.X.slice(0, 200)) {
    const { expected, contribs } = contributions(fitted, x);
    const summed = expected + contribs.reduce((s, v) => s + v, 0);
    assert.ok(
      Math.abs(summed - rawScore(fitted, x)) < 1e-9,
      `decomposition off by ${summed - rawScore(fitted, x)}`,
    );
  }
});

test("calibration pulls predicted rates onto observed ones", () => {
  const uncalibrated = TEST.X.reduce((s, x) => s + predict(fitted, x), 0) / TEST.X.length;

  const calibrated = deserialize(serialize(fitted));
  calibrate(calibrated, CALIB.X, CALIB.y);
  const after = TEST.X.reduce((s, x) => s + predict(calibrated, x), 0) / TEST.X.length;
  const actual = TEST.y.reduce((s: number, v) => s + v, 0) / TEST.y.length;

  assert.ok(
    Math.abs(after - actual) <= Math.abs(uncalibrated - actual) + 1e-9,
    `calibration moved the mean prediction away from the truth: ${uncalibrated} -> ${after}, actual ${actual}`,
  );
  assert.ok(Math.abs(after - actual) < 0.01, `mean prediction ${after.toFixed(4)} vs actual ${actual.toFixed(4)}`);
});

test("calibration preserves the ranking", () => {
  const calibrated = deserialize(serialize(fitted));
  calibrate(calibrated, CALIB.X, CALIB.y);
  const before = rocAuc(TEST.X.map((x) => predict(fitted, x)), TEST.y);
  const after = rocAuc(TEST.X.map((x) => predict(calibrated, x)), TEST.y);
  assert.ok(Math.abs(before - after) < 1e-6, `Platt scaling is monotone and must not reorder: ${before} -> ${after}`);
});

test("a round trip through JSON predicts identically", () => {
  // The nightly retrain writes model.json and the board reads it back; a lossy round trip would
  // mean the scores on screen are not the scores that were validated.
  const revived = deserialize(serialize(fitted));
  for (const x of TEST.X.slice(0, 500)) {
    assert.equal(predict(revived, x), predict(fitted, x));
  }
});

test("the same data and seed produce the same model", () => {
  const again = train(TRAIN.X, TRAIN.y, FEATURE_NAMES);
  assert.equal(serialize(again), serialize(fitted));
});

test("a different seed produces a different model but a comparable one", () => {
  const other = train(TRAIN.X, TRAIN.y, FEATURE_NAMES, { seed: 7 });
  assert.notEqual(serialize(other), serialize(fitted));
  const auc = rocAuc(TEST.X.map((x) => predict(other, x)), TEST.y);
  assert.ok(
    auc > BAYES_AUC - 0.05,
    `seed 7 held-out ROC-AUC ${auc.toFixed(3)} against a ceiling of ${BAYES_AUC.toFixed(3)}; the fit leans on the seed`,
  );
});

test("a label column with no signal in it does not invent one", () => {
  // The honest failure mode: given labels unrelated to the features, the booster should land at
  // chance on held-out rows rather than memorising the training set into something that reads as
  // an edge. A model that scores here would make every validation number in the project a lie.
  const rand = rng(99);
  const noisyTrain = Uint8Array.from(TRAIN.y.map(() => (rand() < 0.025 ? 1 : 0)));
  const noisyTest = Uint8Array.from(TEST.y.map(() => (rand() < 0.025 ? 1 : 0)));

  const noiseModel = train(TRAIN.X, noisyTrain, FEATURE_NAMES);
  const auc = rocAuc(TEST.X.map((x) => predict(noiseModel, x)), noisyTest);
  assert.ok(Math.abs(auc - 0.5) < 0.05, `found ROC-AUC ${auc.toFixed(3)} where the labels are pure noise`);
});
