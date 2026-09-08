import { openDb } from "../db.ts";
import { coveredHours } from "../backtest.ts";
import { earlyFeatures, EARLY_FIELDS, outcomes, type Early } from "../early.ts";
import { buildAthDataset, evaluateAth, type AthRow } from "../model/ath.ts";
import { train } from "../model/gbdt.ts";
import { FEATURES } from "../features.ts";

/**
 * Is the opening seconds' evidence worth adding to the peak model?
 *
 * augur early [--at 30] [--folds 4] [--coverage 0.98]
 *
 * `patterns` answers whether a shape exists. This answers the question that matters afterwards:
 * whether feeding that shape to the model that already exists makes it better, measured the way the
 * rest of this project measures things — same rows, same folds, one column of features added and
 * nothing else changed.
 *
 * It reports against two targets, and the difference between them is the whole point. The shipped
 * peak model predicts the peak over a token's whole life, and that period *contains* the seconds the
 * new features are reading — so a feature saying "the price has already tripled" scores brilliantly
 * against it while telling a buyer nothing they could not see. The forward target measures only what
 * happened after the window closed, which is the multiple somebody buying at that moment could still
 * capture. Only the second one is a claim about the future.
 *
 * The comparison is deliberately unfair to the new features in one respect: both arms are trained
 * and scored only on launches whose curve has been read, which is a small slice of the database. The
 * base arm would do better with the whole thing. Holding the rows fixed is the only way the
 * difference between the two columns is the features and not the sample.
 */
const argv = process.argv.slice(2);
const num = (n: string, d: number): number => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : d;
};

const atSec = num("at", 30);
const folds = num("folds", 4);
const coverage = num("coverage", 0.98);

const db = openDb();
const hours = new Set(coveredHours(db, coverage));
if (!hours.size) {
  console.error("No hour has enough curve coverage — run `npm run curves` first.");
  process.exit(1);
}

const base = buildAthDataset(db).filter((r) => hours.has(Math.floor(r.ts / 3600)));
const early = earlyFeatures(db, atSec, new Set(base.map((r) => r.token)));
const after = outcomes(db, atSec);

const rows: Array<AthRow & { e: Early }> = [];
for (const r of base) {
  const e = early.get(r.token);
  if (e) rows.push({ ...r, e });
}

console.log("\naugur early — does the first half-minute improve the peak model?\n");
console.log(`window     ${hours.size} covered hours, ${rows.length.toLocaleString()} launches with both a peak and a price path`);
console.log(`sees       launch-time features, plus the first ${atSec}s of trading`);
console.log("predicts   two targets, because only one of them is honest:");
console.log(`             forward     the peak reached after the window, over the price at the end of it`);
console.log(`             whole-life  what the shipped model predicts — and it contains the ${atSec}s read`);

if (rows.length < 400) {
  console.error(`\nOnly ${rows.length} launches — too few to fit and fold. Widen coverage with \`npm run curves\`.`);
  process.exit(1);
}

const NAMES = [...FEATURES, ...EARLY_FIELDS.map((f) => `early_${f}`)];
type R = (typeof rows)[number];
const withEarly = (r: R): Float64Array => {
  const x = new Float64Array(r.x.length + EARLY_FIELDS.length);
  x.set(r.x, 0);
  EARLY_FIELDS.forEach((f, i) => {
    const v = r.e[f] as number;
    x[r.x.length + i] = Number.isFinite(v) ? v : 0;
  });
  return x;
};

const OPTS = { objective: "squared" as const, rounds: 200, learningRate: 0.05, maxDepth: 3, minChildHessian: 20 };

type Arm = { spearman: number[]; lift: number[]; gain: number[] };
const blank = (): Arm => ({ spearman: [], lift: [], gain: [] });
const arms: Record<string, Record<string, Arm>> = {
  forward: { base: blank(), early: blank() },
  wholeLife: { base: blank(), early: blank() },
};

/**
 * How much further it went after the window closed.
 *
 * A launch whose curve never printed again has no forward peak to measure, and calling that "flat"
 * would fill the sample with manufactured answers, so it is dropped instead.
 */
const forwardTarget = (token: string): number | null => {
  const pa = after.get(token)?.peakAfter ?? 0;
  return pa > 0 ? Math.log(pa) : null;
};

// Rolling origin, the same discipline the shipped models are held to: every test slice is strictly
// later than everything it was fitted on.
for (let k = 0; k < folds; k++) {
  const trEnd = Math.floor(rows.length * (0.4 + (0.6 * k) / folds));
  const teEnd = Math.floor(rows.length * (0.4 + (0.6 * (k + 1)) / folds));
  const tr = rows.slice(0, trEnd);
  const te = rows.slice(trEnd, teEnd);
  if (tr.length < 200 || te.length < 60) continue;

  for (const target of ["forward", "wholeLife"] as const) {
    const y = (r: R): number | null => (target === "wholeLife" ? r.logPeak : forwardTarget(r.token));
    const trT = tr.filter((r) => y(r) !== null);
    const teT = te.filter((r) => y(r) !== null);
    if (trT.length < 200 || teT.length < 60) continue;

    for (const [name, project, names] of [
      ["base", (r: R) => r.x, [...FEATURES]],
      ["early", withEarly, NAMES],
    ] as const) {
      const m = train(trT.map(project), trT.map((r) => y(r) as number), names, OPTS);
      const ev = evaluateAth(m, teT.map((r) => ({ ...r, x: project(r), logPeak: y(r) as number })));
      arms[target][name].spearman.push(ev.spearman);
      arms[target][name].lift.push(ev.topDecileLift);
      arms[target][name].gain.push(1 - ev.maeModel / ev.maeBaseline);
    }
  }
}

const mean = (v: number[]): number => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0);
const pct = (v: number): string => `${(100 * v).toFixed(1)}%`;

if (!arms.forward.base.spearman.length && !arms.wholeLife.base.spearman.length) {
  console.error("\nNo fold had enough rows on both sides. Widen coverage.");
  process.exit(1);
}

const BLOCKS = [
  ["forward", `FORWARD — the peak after the first ${atSec}s. This is the claim about what happens next.`, ""],
  ["wholeLife", "WHOLE-LIFE — the shipped model's target.",
    `inflated: this target contains the ${atSec}s the new features read, so a feature saying "already up 3x" scores against itself`],
] as const;

for (const [key, title, caveat] of BLOCKS) {
  const a = arms[key];
  if (!a.base.spearman.length) continue;
  console.log(`\n${title}`);
  if (caveat) console.log(`  ${caveat}`);
  console.log(`  ${a.base.spearman.length} folds, each tested on launches later than everything it learned from\n`);
  console.log("                            launch-time only    plus first " + String(atSec).padStart(3) + "s");
  const row = (label: string, f: (x: Arm) => number, fmt: (v: number) => string): void =>
    console.log("  " + label.padEnd(24) + fmt(f(a.base)).padStart(16) + fmt(f(a.early)).padStart(19));
  row("rank correlation", (x) => mean(x.spearman), (v) => v.toFixed(3));
  row("top-decile peak lift", (x) => mean(x.lift), (v) => `${v.toFixed(2)}x`);
  row("beats a constant by", (x) => mean(x.gain), pct);
  console.log("\n  per fold (rank correlation): " +
    a.base.spearman.map((v, i) => `${v.toFixed(2)}->${a.early.spearman[i].toFixed(2)}`).join("   "));
}

console.log(
  "\nThe two blocks are one experiment against two definitions of the answer. The gap between\n" +
  "them is how much of the whole-life figure is the features restating the window they were\n" +
  "measured in rather than predicting anything.",
);

db.close();
