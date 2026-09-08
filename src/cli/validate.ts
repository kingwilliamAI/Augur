import { openDb, setMeta } from "../db.ts";
import { buildDataset, dropCensored, FEATURES } from "../features.ts";
import { evaluate, fullyEnrichedWindow } from "../model/train.ts";
import { calibrate, train } from "../model/gbdt.ts";

/**
 * Rolling-origin validation.
 *
 * `npm run train` reports one split. On a 2.5% positive class that single number swings widely, and
 * it can flatter a model that has no signal or damn one that does. This refits at several sequential
 * cut points and reports the spread, which is the only honest way to answer "does this work".
 *
 * Read the spread, not the mean. A model worth trusting beats chance in most folds; one that is
 * above 0.7 in one fold and at 0.5 in another is telling you it stops working sometimes.
 */
const argv = process.argv.slice(2);
const i = argv.indexOf("--folds");
const FOLDS = i >= 0 ? Number(argv[i + 1]) : 6;

const db = openDb();
const w = fullyEnrichedWindow(db);
if (!w) { console.error("no fully enriched window; run: npm run enrich-window -- --hours 10"); process.exit(1); }

const rows = dropCensored(
  buildDataset(db).filter((r) => r.ts >= w.from && r.ts < w.to),
  Math.floor(Date.now() / 1000),
).sort((a, b) => a.ts - b.ts || a.block - b.block);

console.log(`window ${new Date(w.from * 1000).toISOString()} .. ${new Date(w.to * 1000).toISOString()}`);
console.log(`${rows.length} settled launches, ${rows.filter((r) => r.label).length} graduated\n`);

const results: Array<{ fold: number; test: number; pos: number; base: number; roc: number; prAucLift: number; decLift: number }> = [];
for (let k = 0; k < FOLDS; k++) {
  const trEnd = Math.floor((rows.length * (0.4 + (0.6 * k) / FOLDS)));
  const teEnd = Math.floor((rows.length * (0.4 + (0.6 * (k + 1)) / FOLDS)));
  const tr = rows.slice(0, Math.floor(trEnd * 0.85));
  const ca = rows.slice(Math.floor(trEnd * 0.85), trEnd);
  const te = rows.slice(trEnd, teEnd);
  if (te.length < 100 || ca.length < 50) continue;

  const m = train(tr.map((r) => r.x), Uint8Array.from(tr.map((r) => r.label)), [...FEATURES]);
  calibrate(m, ca.map((r) => r.x), Uint8Array.from(ca.map((r) => r.label)));
  const e = evaluate(m, te);
  results.push({ fold: k + 1, test: te.length, pos: e.positives, base: 100 * e.baseRate, roc: e.rocAuc, prAucLift: e.prAucLift, decLift: e.topDecileLift });
}

console.log("fold   test   pos   base%   ROC-AUC   PR-AUC/base   decile/base");
for (const r of results) {
  console.log(
    `  ${String(r.fold).padStart(2)}  ${String(r.test).padStart(5)}  ${String(r.pos).padStart(4)}  ${r.base.toFixed(2).padStart(6)}` +
    `    ${r.roc.toFixed(3)}        ${r.prAucLift.toFixed(2)}x         ${r.decLift.toFixed(2)}x`,
  );
}

const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / a.length;
const sd = (a: number[]): number => Math.sqrt(mean(a.map((v) => (v - mean(a)) ** 2)));
const rocs = results.map((r) => r.roc);
const decs = results.map((r) => r.decLift);
const atChance = rocs.filter((r) => r < 0.55).length;

console.log(`\nROC-AUC       mean ${mean(rocs).toFixed(3)}  sd ${sd(rocs).toFixed(3)}  worst ${Math.min(...rocs).toFixed(3)}`);
console.log(`decile lift   mean ${mean(decs).toFixed(2)}x  sd ${sd(decs).toFixed(2)}  worst ${Math.min(...decs).toFixed(2)}x`);
console.log(
  atChance === 0
    ? "\nEvery fold beat chance. The signal is repeatable over this window."
    : `\n${atChance} of ${results.length} folds scored at or near chance (ROC < 0.55). The model works on average` +
      "\nbut stops working in some stretches, so treat a single score as weaker evidence than the mean suggests.",
);

// The board's Model page shows these same numbers. Persisting them here means the page reads what
// this command actually printed, instead of either recomputing six folds per page view or, worse,
// showing a figure nobody ran.
setMeta(db, "validation_json", JSON.stringify({
  at: Math.floor(Date.now() / 1000),
  window: w,
  rows: rows.length,
  positives: rows.filter((r) => r.label).length,
  folds: results,
  roc: { mean: mean(rocs), sd: sd(rocs), worst: Math.min(...rocs) },
  decile: { mean: mean(decs), sd: sd(decs), worst: Math.min(...decs) },
  atChance,
}));
db.close();
