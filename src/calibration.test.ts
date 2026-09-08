import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLive, fitLive, liveFor, MIN_CLAIMS, saveLive, SLOPE_RANGE } from "./calibration.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * The correction has one job and one prohibition: move the printed probability toward what happened,
 * and never change the order of the list. The prohibition is the important one — the ranking is the
 * whole product, and a calibration bug that quietly reordered it would be invisible on a card.
 */

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Claims from a model that overstates: it says `p`, the truth is a smaller number. */
function overstating(n: number, seed = 5): Array<{ probability: number; label: 0 | 1 }> {
  const rand = rng(seed);
  const rows: Array<{ probability: number; label: 0 | 1 }> = [];
  for (let i = 0; i < n; i++) {
    const p = 0.005 + rand() * 0.1;
    const truth = sigmoid(Math.log(p / (1 - p)) - 0.7);
    rows.push({ probability: p, label: rand() < truth ? 1 : 0 });
  }
  return rows;
}

test("refuses to fit on too few claims", () => {
  assert.equal(fitLive(overstating(MIN_CLAIMS - 1)), null);
});

test("pulls an overstating model back toward what happened", () => {
  const rows = overstating(6000);
  const fit = fitLive(rows);
  assert.ok(fit);

  const said = rows.reduce((s, r) => s + r.probability, 0) / rows.length;
  const was = rows.reduce((s, r) => s + r.label, 0) / rows.length;
  const after = rows.reduce((s, r) => s + applyLive(fit, r.probability), 0) / rows.length;

  assert.ok(said > was, "the fixture should overstate, or this test proves nothing");
  assert.ok(
    Math.abs(after - was) < Math.abs(said - was),
    `correction moved the wrong way: said ${said}, was ${was}, after ${after}`,
  );
  assert.ok(Math.abs(after - was) < 0.004, `still off by ${(after - was).toFixed(4)}`);
});

test("never changes the order of the list", () => {
  const fit = fitLive(overstating(6000));
  assert.ok(fit);
  const ps = Array.from({ length: 400 }, (_, i) => 0.0005 + (i / 400) * 0.6);
  const after = ps.map((p) => applyLive(fit, p));
  for (let i = 1; i < after.length; i++) {
    assert.ok(after[i] > after[i - 1], `reordered at ${i}: ${after[i - 1]} then ${after[i]}`);
  }
});

test("refuses a correction too large for a two-parameter nudge to be honest", () => {
  // Labels unrelated to the scores: no slope can fix that, and rescaling would hide it.
  const rand = rng(9);
  const rows = Array.from({ length: 4000 }, () => ({
    probability: 0.9 + rand() * 0.09,
    label: (rand() < 0.001 ? 1 : 0) as 0 | 1,
  }));
  const fit = fitLive(rows);
  assert.ok(fit === null || (fit.a >= SLOPE_RANGE[0] && fit.a <= SLOPE_RANGE[1]));
});

test("a well-calibrated model is left roughly alone", () => {
  const rand = rng(11);
  const rows = Array.from({ length: 6000 }, () => {
    const p = 0.005 + rand() * 0.1;
    return { probability: p, label: (rand() < p ? 1 : 0) as 0 | 1 };
  });
  const fit = fitLive(rows);
  assert.ok(fit);
  const said = rows.reduce((s, r) => s + r.probability, 0) / rows.length;
  const after = rows.reduce((s, r) => s + applyLive(fit, r.probability), 0) / rows.length;
  assert.ok(Math.abs(after - said) < 0.01, `moved a good model by ${(after - said).toFixed(4)}`);
});

test("a fit taken from already-corrected scores throws the correction away", () => {
  // The real failure is not drift but oscillation. The stored correction is absolute — the board
  // applies it to the model's raw score — while a refit that reads the shown value is fitted on
  // numbers that correction already moved. Those look well calibrated, so the refit comes back as
  // roughly the identity, and storing it undoes the correction entirely. The board overstates again,
  // the next pass refits it back, and the printed number swings between two answers forever while
  // the ranking, and therefore every dashboard, looks perfectly stable.
  const rows = overstating(6000);
  const good = fitLive(rows);
  assert.ok(good);

  const corrected = rows.map((r) => ({ probability: applyLive(good, r.probability), label: r.label }));
  const fromShown = fitLive(corrected);
  assert.ok(fromShown);

  const was = rows.reduce((s, r) => s + r.label, 0) / rows.length;
  const withGood = rows.reduce((s, r) => s + applyLive(good, r.probability), 0) / rows.length;
  const withWrong = rows.reduce((s, r) => s + applyLive(fromShown, r.probability), 0) / rows.length;

  assert.ok(Math.abs(withGood - was) < 0.004, "the fit from raw scores should land on the truth");
  assert.ok(
    Math.abs(withWrong - was) > Math.abs(withGood - was) * 3,
    `a fit from shown scores should be far worse when applied to raw ones: ` +
    `truth ${was.toFixed(4)}, from raw ${withGood.toFixed(4)}, from shown ${withWrong.toFixed(4)}`,
  );
});

test("a correction fitted on one model is not handed to another", () => {
  // This was relaxed once, on the reasoning that a model always retires before it can be corrected.
  // It does not: a model gathers about a thousand claims an hour and they settle after four, so it
  // has some twenty hours in which its own claims can correct it. Meanwhile the relaxed version
  // handed a twofold correction to a successor that needed none, and would have printed 0.35% where
  // 1.40% happened.
  const dir = mkdtempSync(join(tmpdir(), "augur-cal-"));
  const path = join(dir, "calibration.json");
  try {
    saveLive({ modelId: "aaaaaaaaaaaa", a: 1.17, b: -0.69, n: 2217,
      fittedAt: Math.floor(Date.now() / 1000), saidBefore: 0.026, wasBefore: 0.008 }, path);
    assert.ok(liveFor("aaaaaaaaaaaa", path), "the model it was fitted on must get it");
    assert.equal(liveFor("bbbbbbbbbbbb", path), null, "and no other model may, however fresh the fit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
